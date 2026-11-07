"""Model providers of the AI gateway (docs/llm-providers.md, docs/adr/0022-llm-providers.md).

One path for every kind: LiteLLM (`litellm.acompletion`, MIT; nothing from its enterprise
package is installed or used). API keys, aggregators, custom OpenAI-compatible endpoints and
local servers (vLLM, Ollama) are LiteLLM providers; vendor CLI subscriptions are served by the
llm-cli container (services/llm-cli) as OpenAI-compatible endpoints, so LiteLLM reaches them
like any other. Which providers exist and where their keys are: `providers` in
config/ai-models.json. Prices come from LiteLLM's bundled model cost map (`price_from_litellm`).

Organization-owned providers (BYO, `byo_provider`) use the same path. A custom base URL is
checked like a webhook target: every address of the host must be public unless allow-listed,
and the connection goes to the checked address (Host header and TLS SNI keep the name), so DNS
cannot swap the target between check and connect.
"""

import json
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, replace
from decimal import Decimal
from ipaddress import IPv4Network, IPv6Network
from pathlib import Path
from typing import Any, Literal, cast
from urllib.parse import urlsplit

import httpx2
import litellm
from litellm.exceptions import RateLimitError
from openai import AsyncOpenAI

from worker.webhooks import resolve_public

litellm.suppress_debug_info = True

Kind = Literal["cli", "api", "aggregator", "custom", "local"]
KINDS: frozenset[str] = frozenset({"cli", "api", "aggregator", "custom", "local"})
# Kinds an organization may bring its own key for (docs/llm-providers.md "BYO").
BYO_KINDS: frozenset[str] = frozenset({"api", "aggregator", "custom"})


@dataclass(frozen=True)
class Message:
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class Completion:
    """What a provider returns. `model` is the exact id the provider reported, if any."""

    text: str
    model: str | None
    input_tokens: int | None
    output_tokens: int | None
    response_id: str | None = None


# (model, messages, max_tokens) -> Completion
Provider = Callable[[str, Sequence[Message], int], Awaitable[Completion]]


@dataclass(frozen=True)
class ProviderConfig:
    name: str
    kind: Kind
    litellm: str  # LiteLLM provider prefix: `<prefix>/<model>`
    base_url: str | None
    api_key: str | None
    timeout: float

    @property
    def configured(self) -> bool:
        """Has what it needs to be called (fallbacks to an unconfigured provider are skipped)."""
        if self.kind in ("cli", "local", "custom"):
            return bool(self.base_url)
        return bool(self.api_key)


def load_providers(
    path: Path,
    env: Mapping[str, str],
    *,
    cli_url: str,
    cli_token: str,
    timeout: float,
    cli_timeout: float,
) -> dict[str, ProviderConfig]:
    """`providers` of config/ai-models.json with keys and base URLs read from `env`."""
    doc: dict[str, dict[str, Any]] = json.loads(path.read_text())["providers"]
    out: dict[str, ProviderConfig] = {}
    for name, p in doc.items():
        kind = str(p["kind"])
        if kind not in KINDS:
            raise ValueError(f"provider {name!r}: unknown kind {kind!r}")
        if kind == "cli":
            # The llm-cli shim serves each CLI at /<cli>/v1/chat/completions (OpenAI format).
            base = f"{cli_url.rstrip('/')}/{p['cli']}/v1" if cli_url else None
            out[name] = ProviderConfig(name, "cli", "openai", base, cli_token, cli_timeout)
            continue
        base_env, key_env = p.get("baseUrlEnv"), p.get("apiKeyEnv")
        out[name] = ProviderConfig(
            name,
            cast(Kind, kind),
            str(p["litellm"]),
            env.get(base_env) or None if base_env else None,
            env.get(key_env) or None if key_env else None,
            timeout,
        )
    return out


def _completion(res: Any, prefix: str) -> Completion:
    choices: list[Any] = res.choices or []
    usage: Any = getattr(res, "usage", None)
    model: str | None = res.model
    if model and model.startswith(f"{prefix}/"):  # LiteLLM prefixes some reported ids
        model = model[len(prefix) + 1 :]
    return Completion(
        (choices[0].message.content or "") if choices else "",
        model,
        usage.prompt_tokens if usage else None,
        usage.completion_tokens if usage else None,
        res.id,
    )


def litellm_provider(cfg: ProviderConfig, client: AsyncOpenAI | None = None) -> Provider:
    async def call(model: str, messages: Sequence[Message], max_tokens: int) -> Completion:
        res = await litellm.acompletion(
            model=f"{cfg.litellm}/{model}",
            messages=[asdict(m) for m in messages],
            max_tokens=max_tokens,
            api_base=cfg.base_url,
            # Always explicit: LiteLLM would otherwise fall back to e.g. OPENAI_API_KEY from the
            # environment and send the operator's key to another endpoint.
            api_key=cfg.api_key or "none",
            timeout=cfg.timeout,
            num_retries=0,  # Temporal retries the activity; fallbacks are the gateway's
            client=client,
        )
        return _completion(res, cfg.litellm)

    return call


def providers_from_config(configs: Mapping[str, ProviderConfig]) -> dict[str, Provider]:
    return {name: litellm_provider(cfg) for name, cfg in configs.items()}


def is_rate_limited(err: BaseException) -> bool:
    return isinstance(err, RateLimitError)


def price_from_litellm(cfg: ProviderConfig, model: str) -> tuple[Decimal, Decimal] | None:
    """(input, output) USD per 1,000 tokens from LiteLLM's cost map, None if it has none.

    Only for vendor APIs and aggregators: a CLI subscription, a self-hosted server or a custom
    endpoint is not billed at the vendor's list price. A zero price counts as unknown, so a
    model the map lists as free is still refused unless the registry prices or unmeters it.
    """
    if cfg.kind not in ("api", "aggregator"):
        return None
    try:
        info: Any = litellm.get_model_info(model=model, custom_llm_provider=cfg.litellm)
    except Exception:  # not in the map: LiteLLM raises
        return None
    cost_in, cost_out = info.get("input_cost_per_token"), info.get("output_cost_per_token")
    if not cost_in or not cost_out:
        return None
    return Decimal(str(cost_in)) * 1000, Decimal(str(cost_out)) * 1000


class PinnedTransport(httpx2.AsyncHTTPTransport):
    """Connects to an already checked IP; the URL host stays in the Host header and TLS SNI."""

    def __init__(self, ip: str, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.ip = ip

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        host = request.url.host
        request.url = request.url.copy_with(host=self.ip)
        request.extensions = {**request.extensions, "sni_hostname": host}
        return await super().handle_async_request(request)


class BlockedEndpoint(Exception):
    """A BYO base URL that is not http(s) or resolves to a non-public address."""


Network = IPv4Network | IPv6Network


async def byo_provider(
    template: ProviderConfig,
    *,
    base_url: str | None,
    api_key: str | None,
    allowed: Sequence[Network],
) -> Provider:
    """A provider for one organization's own key (and base URL for the custom kind)."""
    if template.kind not in BYO_KINDS:
        raise BlockedEndpoint(f"provider kind {template.kind} cannot be brought by an org")
    if template.kind != "custom":
        # Vendor endpoints are fixed by LiteLLM; only the key is the organization's.
        return litellm_provider(replace(template, base_url=None, api_key=api_key))
    parts = urlsplit(base_url or "")
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.username:
        raise BlockedEndpoint("invalid base URL")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        ip = await resolve_public(parts.hostname, port, allowed)
    except Exception as err:  # BlockedAddress or DNS failure
        raise BlockedEndpoint(f"base URL host is not allowed ({type(err).__name__})") from err
    cfg = replace(template, base_url=base_url, api_key=api_key)

    async def call(model: str, messages: Sequence[Message], max_tokens: int) -> Completion:
        http = httpx2.AsyncClient(
            transport=PinnedTransport(ip),
            trust_env=False,  # no proxy from the environment: we connect to the checked IP
            follow_redirects=False,
            timeout=cfg.timeout,
        )
        client = AsyncOpenAI(
            base_url=base_url, api_key=api_key or "none", http_client=http, max_retries=0
        )
        try:
            return await litellm_provider(cfg, client)(model, messages, max_tokens)
        finally:
            await client.close()

    return call

"""Provider routing per kind through LiteLLM against a local HTTP mock (no network, no keys).

Checks the URL, auth header and model we send for each kind, the fields we read back, prices
from LiteLLM's cost map, and the SSRF guard of organization-owned custom endpoints.
"""

import json
import threading
from collections.abc import Iterator
from dataclasses import replace
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import ip_network
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import asyncpg
import pytest

from tests.conftest import new_org
from worker import providers, settings
from worker.ai import Gateway, ModelNotAllowed, load_registry
from worker.providers import (
    BlockedEndpoint,
    Completion,
    Message,
    NotConfigured,
    ProviderConfig,
    byo_provider,
    load_providers,
    price_from_litellm,
    providers_from_config,
)
from worker.s3 import S3

MESSAGES = [Message("system", "Be brief."), Message("user", "Hi")]
OPENAI = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "created": 0,
    "model": "reported-model",
    "choices": [
        {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "Hello."}}
    ],
    "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
}
ANTHROPIC = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "claude-haiku-5-5",
    "content": [{"type": "text", "text": "Hello."}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 12, "output_tokens": 3},
}
GEMINI = {
    "candidates": [
        {"content": {"parts": [{"text": "Hello."}], "role": "model"}, "finishReason": "STOP"}
    ],
    "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 3, "totalTokenCount": 15},
    "modelVersion": "gemini-3.5-flash",
}
OLLAMA = {
    "model": "qwen3:0.6b",
    "created_at": "2026-11-07T00:00:00Z",
    "message": {"role": "assistant", "content": "Hello."},
    "done": True,
    "done_reason": "stop",
    "prompt_eval_count": 12,
    "eval_count": 3,
}


class Mock:
    def __init__(self) -> None:
        self.seen: list[dict[str, Any]] = []
        mock = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                mock.seen.append({"path": self.path, "headers": dict(self.headers), "body": body})
                reply = (
                    ANTHROPIC
                    if "/messages" in self.path
                    else GEMINI
                    if "generateContent" in self.path
                    else OLLAMA
                    if self.path == "/api/chat"
                    else OPENAI
                )
                data = json.dumps(reply).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, format: str, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_port
        self.url = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def posts(self) -> list[dict[str, Any]]:
        # Ollama's adapter may also ask /api/show for model info: only chat requests count.
        return [s for s in self.seen if s["path"] != "/api/show"]


@pytest.fixture(scope="module")
def mock() -> Iterator[Mock]:
    m = Mock()
    yield m
    m.server.shutdown()


@pytest.fixture
def configs(mock: Mock) -> dict[str, ProviderConfig]:
    env = {
        "ANTHROPIC_API_KEY": "local-dev-anthropic",
        "GEMINI_API_KEY": "local-dev-gemini",
        "OPENROUTER_API_KEY": "local-dev-openrouter",
        "OPENAI_COMPATIBLE_BASE_URL": f"{mock.url}/custom/v1",
        "VLLM_BASE_URL": f"{mock.url}/v1",
        "VLLM_API_KEY": "local-dev-vllm",
        "OLLAMA_BASE_URL": mock.url,
    }
    found = load_providers(
        settings.AI_MODELS_FILE,
        env,
        cli_url=f"{mock.url}/",
        cli_token="local-dev-llm-cli-token",  # noqa: S106 - test value
        timeout=10,
        cli_timeout=10,
    )
    # The shipped config names each vendor's own endpoint: same path, the mock's host.
    for name, cfg in found.items():
        if cfg.kind in ("api", "aggregator"):
            assert cfg.base_url
            found[name] = replace(cfg, base_url=mock.url + urlsplit(cfg.base_url).path)
    return found


# provider, model, expected path, auth header (name, value), expected completion
CASES = [
    (
        "claude_cli",
        "claude-haiku-5-5",
        "/claude/v1/chat/completions",
        ("authorization", "Bearer local-dev-llm-cli-token"),
        "reported-model",
    ),
    (
        "codex_cli",
        "gpt-5.5",
        "/codex/v1/chat/completions",
        ("authorization", "Bearer local-dev-llm-cli-token"),
        "reported-model",
    ),
    (
        "anthropic",
        "claude-haiku-5-5",
        "/v1/messages",
        ("x-api-key", "local-dev-anthropic"),
        "claude-haiku-5-5",
    ),
    (
        "gemini",
        "gemini-3.5-flash",
        "/v1beta/models/gemini-3.5-flash:generateContent",
        ("x-goog-api-key", "local-dev-gemini"),
        "gemini-3.5-flash",
    ),
    (
        "openrouter",
        "anthropic/claude-sonnet-5.5",
        "/api/v1/chat/completions",
        ("authorization", "Bearer local-dev-openrouter"),
        "reported-model",
    ),
    (
        "openai_compatible",
        "example-model",
        "/custom/v1/chat/completions",
        ("authorization", "Bearer none"),
        "reported-model",
    ),
    (
        "vllm",
        "Qwen/Qwen3-0.6B",
        "/v1/chat/completions",
        ("authorization", "Bearer local-dev-vllm"),
        "reported-model",
    ),
    ("ollama", "qwen3:0.6b", "/api/chat", None, "qwen3:0.6b"),
]


@pytest.mark.parametrize(("provider", "model", "path", "auth", "reported"), CASES)
async def test_routes_each_kind_through_litellm(
    mock: Mock,
    configs: dict[str, ProviderConfig],
    monkeypatch: pytest.MonkeyPatch,
    provider: str,
    model: str,
    path: str,
    auth: tuple[str, str] | None,
    reported: str,
) -> None:
    # An operator key in the environment must never reach another endpoint.
    monkeypatch.setenv("OPENAI_API_KEY", "local-dev-operator-openai-key")
    mock.seen.clear()
    call = providers_from_config(configs)[provider]

    completion = await call(model, MESSAGES, 64)

    assert completion.text == "Hello."
    assert (completion.input_tokens, completion.output_tokens) == (12, 3)
    assert completion.model == reported
    [sent] = mock.posts()
    assert sent["path"].split("?")[0] == path
    headers = {k.lower(): v for k, v in sent["headers"].items()}
    if auth:
        assert headers[auth[0]] == auth[1]
    assert "local-dev-operator-openai-key" not in json.dumps(headers)
    if "chat/completions" in path:
        assert sent["body"]["model"] == model
        assert sent["body"]["messages"][0] == {"role": "system", "content": "Be brief."}


def test_configured_and_unknown_kinds(tmp_path: Path, configs: dict[str, ProviderConfig]) -> None:
    assert configs["claude_cli"].configured and configs["vllm"].configured
    bare = load_providers(
        settings.AI_MODELS_FILE, {}, cli_url="", cli_token="", timeout=1, cli_timeout=1
    )
    assert not bare["claude_cli"].configured and not bare["anthropic"].configured
    assert bare["anthropic"].base_url == "https://api.anthropic.com"  # explicit, never from env
    bad = tmp_path / "models.json"
    bad.write_text(json.dumps({"providers": {"x": {"kind": "magic"}}}))
    with pytest.raises(ValueError, match="unknown kind"):
        load_providers(bad, {}, cli_url="", cli_token="", timeout=1, cli_timeout=1)
    bad.write_text(json.dumps({"providers": {"x": {"kind": "api", "litellm": "openai"}}}))
    with pytest.raises(ValueError, match="baseUrl"):
        load_providers(bad, {}, cli_url="", cli_token="", timeout=1, cli_timeout=1)


# LiteLLM reads these when api_base is None; none of them may ever be used.
ENV_BASES = ("OPENAI_BASE_URL", "OPENAI_API_BASE", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_BASE")


async def test_unconfigured_provider_is_refused_without_a_request(
    mock: Mock, pool: asyncpg.Pool, s3: S3, monkeypatch: pytest.MonkeyPatch
) -> None:
    for name in ENV_BASES:
        monkeypatch.setenv(name, f"{mock.url}/leak/v1")
    bare = load_providers(
        settings.AI_MODELS_FILE, {}, cli_url="", cli_token="", timeout=5, cli_timeout=5
    )
    org = await new_org(pool)
    mock.seen.clear()
    for contour, provider, model in (
        ("eu", "claude_cli", "claude-haiku-5-5"),  # no LLM_CLI_URL
        ("ru", "openai_compatible", "example-self-hosted-model"),  # no base URL
    ):
        gateway = Gateway(
            pool=pool,
            s3=s3,
            contour=contour,
            registry=load_registry(settings.AI_MODELS_FILE, contour),
            providers=providers_from_config(bare),
            provider_configs=bare,
            retention_days=1,
        )
        with pytest.raises(ModelNotAllowed, match="not configured"):
            await gateway.call_llm(
                "project.summary",
                MESSAGES,
                model=model,
                provider=provider,
                org_id=org,
                actor_id=None,
                prompt_template_id="t",
                prompt_template_version="1",
                max_tokens=16,
            )
        # Below the gateway too: a provider without a base URL never calls LiteLLM.
        with pytest.raises(NotConfigured):
            await providers_from_config(bare)[provider](model, MESSAGES, 16)
    assert mock.posts() == []


async def test_vendor_base_url_is_explicit_for_byo_keys(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ENV_BASES:
        monkeypatch.setenv(name, "http://127.0.0.1:9/leak")
    sent: list[dict[str, Any]] = []

    async def acompletion(**kwargs: Any) -> Any:
        sent.append(kwargs)
        raise RuntimeError("stop")

    monkeypatch.setattr(providers.litellm, "acompletion", acompletion)
    bare = load_providers(
        settings.AI_MODELS_FILE, {}, cli_url="", cli_token="", timeout=1, cli_timeout=1
    )
    call = await byo_provider(bare["anthropic"], base_url=None, api_key="org-key", allowed=[])
    with pytest.raises(RuntimeError, match="stop"):
        await call("claude-haiku-5-5", MESSAGES, 16)
    assert (sent[0]["api_base"], sent[0]["api_key"]) == ("https://api.anthropic.com", "org-key")


def test_prices_come_from_litellms_cost_map(configs: dict[str, ProviderConfig]) -> None:
    assert price_from_litellm(configs["anthropic"], "claude-haiku-5-5") == (
        Decimal("0.0001"),
        Decimal("0.0005"),
    )
    assert price_from_litellm(configs["anthropic"], "no-such-model") is None
    # A subscription or a self-hosted model is never billed at the vendor's list price.
    assert price_from_litellm(configs["claude_cli"], "claude-haiku-5-5") is None
    assert price_from_litellm(configs["vllm"], "Qwen/Qwen3-0.6B") is None


async def test_byo_custom_endpoint_is_pinned_and_guarded(
    mock: Mock, configs: dict[str, ProviderConfig], monkeypatch: pytest.MonkeyPatch
) -> None:
    checked: list[tuple[str, int]] = []

    async def resolve(host: str, port: int, allowed: object) -> str:
        checked.append((host, port))
        return "127.0.0.1"  # the checked address; the name itself does not resolve to the mock

    monkeypatch.setattr(providers, "resolve_public", resolve)
    mock.seen.clear()
    call = await byo_provider(
        configs["openai_compatible"],
        base_url=f"http://llm.example.com:{mock.port}/org/v1",
        api_key="local-dev-org-key",
        allowed=[],
    )
    completion = await call("org-model", MESSAGES, 16)
    assert completion == Completion("Hello.", "reported-model", 12, 3, "chatcmpl-1")
    assert checked == [("llm.example.com", mock.port)]
    [sent] = mock.posts()
    assert sent["path"] == "/org/v1/chat/completions"
    headers = {k.lower(): v for k, v in sent["headers"].items()}
    assert headers["host"] == f"llm.example.com:{mock.port}"  # name kept, IP connected
    assert headers["authorization"] == "Bearer local-dev-org-key"
    monkeypatch.undo()

    # The real check: loopback and private addresses only with an operator allow-list.
    for url in ("http://localhost/v1", "http://10.0.0.1/v1", "ftp://llm.example.com/v1"):
        with pytest.raises(BlockedEndpoint):
            await byo_provider(configs["openai_compatible"], base_url=url, api_key="k", allowed=[])
    await byo_provider(
        configs["openai_compatible"],
        base_url="http://10.0.0.1/v1",
        api_key="k",
        allowed=[ip_network("10.0.0.0/24")],
    )
    with pytest.raises(BlockedEndpoint):  # CLI subscriptions and local servers are the operator's
        await byo_provider(configs["claude_cli"], base_url=None, api_key="k", allowed=[])

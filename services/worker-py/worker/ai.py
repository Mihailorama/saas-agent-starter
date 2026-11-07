"""AI gateway: every LLM call goes through `Gateway.call_llm` (see docs/adr/0008-ai-layer.md).

Per call it checks the model registry (config/ai-models.json) for the current contour, routes
to the organization's own provider if it brought one (BYO), applies the plan's money limit
(priced models) or calls/tokens limit (unmetered models), stores the request and response
content as S3 objects, emits one OpenTelemetry span with GenAI semantic-convention attributes
(never prompt content), and appends one `ai_calls` row. Providers: worker/providers.py.
"""

import json
import logging
import time
import uuid
from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import asyncpg
from opentelemetry import metrics, trace
from opentelemetry.trace import SpanKind, Status, StatusCode
from temporalio.exceptions import ApplicationError

from worker.billing import Plans, byo_allowed, check_llm_budget, check_llm_usage
from worker.flags import is_enabled
from worker.posthog import PostHogAi
from worker.providers import (
    BlockedEndpoint,
    Network,
    ProviderConfig,
    byo_provider,
    is_rate_limited,
    price_from_litellm,
)
from worker.providers import Completion as Completion
from worker.providers import Message as Message
from worker.providers import Provider as Provider
from worker.s3 import S3
from worker.webhooks import decrypt_secret

log = logging.getLogger(__name__)
tracer = trace.get_tracer("worker.ai")
meter = metrics.get_meter("worker.ai")
# Names and labels agreed with the Grafana "LLM" dashboard and alerts (AGENTS.md "Observability").
# Labels are low-cardinality only, never ids or content.
calls_counter = meter.create_counter("ai_calls", description="LLM calls by outcome")
latency_histogram = meter.create_histogram(
    "ai_call_latency_seconds", description="LLM call latency in seconds"
)
cost_counter = meter.create_counter("ai_cost_usd", description="LLM cost in USD")


@dataclass(frozen=True)
class LlmResult:
    call_id: uuid.UUID
    text: str


@dataclass(frozen=True)
class Price:
    input: Decimal  # per 1,000 tokens
    output: Decimal
    currency: str


@dataclass(frozen=True)
class Fallback:
    provider: str
    model: str


@dataclass(frozen=True)
class AllowedModel:
    purposes: frozenset[str]
    # Explicit override; None = LiteLLM's cost map (Gateway.price_of).
    price: Price | None
    # Explicit opt-out from cost tracking and the money limit; counted against the plan's
    # calls/tokens limit instead. An unpriced model without it is refused (fail closed).
    unmetered: bool = False
    fallback: Fallback | None = None


Registry = dict[tuple[str, str], AllowedModel]  # (provider, model) -> rules


def load_registry(path: Path, contour: str) -> Registry:
    """Allowed models for one contour. Fails loudly on an unknown contour."""
    contours: dict[str, list[dict[str, Any]]] = json.loads(path.read_text())["contours"]
    if contour not in contours:
        raise ValueError(f"contour {contour!r} is not in {path} (have: {sorted(contours)})")
    registry: Registry = {}
    for entry in contours[contour]:
        p: dict[str, Any] | None = entry.get("pricePer1kTokens")
        price = (
            Price(Decimal(str(p["input"])), Decimal(str(p["output"])), str(p["currency"]))
            if p
            else None
        )
        fb: dict[str, Any] | None = entry.get("fallback")
        purposes: list[str] = entry["purposes"]
        registry[(str(entry["provider"]), str(entry["model"]))] = AllowedModel(
            frozenset(purposes),
            price,
            entry.get("unmetered") is True,
            Fallback(str(fb["provider"]), str(fb["model"])) if fb else None,
        )
    return registry


@dataclass(frozen=True)
class Byo:
    """Organization-owned providers (ai_providers): key ring and the custom-URL allow-list."""

    keys: Mapping[str, bytes]
    allowed_networks: Sequence[Network] = field(default_factory=list[Network])


@dataclass(frozen=True)
class _Route:
    provider: str  # as recorded in ai_calls: registry name, or byo:<name> for an org's own
    model: str
    call: Provider
    price: Price | None


class ModelNotAllowed(ApplicationError):
    def __init__(self, message: str) -> None:
        super().__init__(message, type="ModelNotAllowed", non_retryable=True)


class ProviderBlocked(ApplicationError):
    def __init__(self, message: str) -> None:
        super().__init__(message, type="ProviderBlocked", non_retryable=True)


class Gateway:
    def __init__(
        self,
        *,
        pool: asyncpg.Pool,
        s3: S3,
        contour: str,
        registry: Registry,
        providers: Mapping[str, Provider],
        retention_days: int,
        provider_configs: Mapping[str, ProviderConfig] | None = None,
        posthog: PostHogAi | None = None,
        plans: Plans | None = None,
        byo: Byo | None = None,
    ) -> None:
        self.pool, self.s3, self.contour = pool, s3, contour
        self.posthog, self.plans, self.byo = posthog, plans, byo
        self.registry, self.providers = registry, providers
        self.configs = provider_configs or {}
        self.retention = timedelta(days=retention_days)
        # Usage (calls/tokens) limits count the calls of these models (provider/model).
        self.unmetered = sorted(f"{p}/{m}" for (p, m), a in registry.items() if a.unmetered)
        # Providers this contour lists; an org may bring its own key only for one of these.
        self.contour_providers = frozenset(p for p, _ in registry)

    async def call_llm(
        self,
        purpose: str,
        messages: Sequence[Message],
        *,
        model: str,
        provider: str,
        org_id: str,
        actor_id: str | None,
        prompt_template_id: str,
        prompt_template_version: str,
        max_tokens: int,
    ) -> LlmResult:
        """One LLM call, logged. The span joins the current OTel trace (Temporal propagates it).

        If the org brought its own provider for `purpose` (flag `byo-llm-providers` on, its plan
        allows it, the provider listed for this contour), that one is called instead, without
        plan limits (the org pays its provider). Otherwise raises
        ModelNotAllowed (non-retryable) if (provider, model, purpose) is not registered for
        this contour or has no price and is not `unmetered`, SpendLimitExceeded /
        UsageLimitExceeded (non-retryable) at the plan's limit. A rate-limited call (429) is
        retried once per configured `fallback`; every attempt gets its own ai_calls row.
        Provider errors are logged as status=error and re-raised.
        """
        args = (purpose, messages, org_id, actor_id, prompt_template_id, prompt_template_version)
        byo = self.byo is not None and await is_enabled(
            "byo-llm-providers", user_id=actor_id or org_id, org_id=org_id
        )
        own = await self._byo_route(org_id, purpose) if byo else None
        if own is not None:
            return await self._call(own, *args, max_tokens)
        tried: set[tuple[str, str]] = set()
        while True:
            allowed, route = self._route(purpose, provider, model)
            if self.plans is not None:
                if route.price is not None:
                    await check_llm_budget(self.pool, self.plans, org_id, route.price.currency)
                else:
                    await check_llm_usage(self.pool, self.plans, org_id, self.unmetered)
            try:
                return await self._call(route, *args, max_tokens)
            except Exception as err:
                tried.add((provider, model))
                fb = allowed.fallback
                if (
                    not is_rate_limited(err)
                    or fb is None
                    or (fb.provider, fb.model) in tried
                    or not self._configured(fb.provider)
                ):
                    raise
                log.warning(
                    "%s/%s rate-limited, falling back to %s/%s",
                    provider,
                    model,
                    *asdict(fb).values(),
                )
                provider, model = fb.provider, fb.model

    def _route(self, purpose: str, provider: str, model: str) -> tuple[AllowedModel, _Route]:
        allowed = self.registry.get((provider, model))
        call = self.providers.get(provider)
        if allowed is None or purpose not in allowed.purposes or call is None:
            raise ModelNotAllowed(
                f"{provider}/{model} is not allowed for {purpose!r} in contour {self.contour!r}"
            )
        if not self._configured(provider):
            # No base URL/key: LiteLLM would fall back to the environment or a vendor default.
            raise ModelNotAllowed(
                f"provider {provider!r} is not configured (docs/llm-providers.md)"
            )
        price = self.price_of(provider, model)
        if price is None and not allowed.unmetered:
            # No price, no cost, no spend limit: refuse rather than let calls through unbilled.
            raise ModelNotAllowed(
                f"{provider}/{model} has no price (registry or LiteLLM's cost map); set"
                ' pricePer1kTokens or mark it "unmetered": true'
            )
        return allowed, _Route(provider, model, call, None if allowed.unmetered else price)

    def _configured(self, provider: str) -> bool:
        cfg = self.configs.get(provider)
        return cfg.configured if cfg else provider in self.providers

    def price_of(self, provider: str, model: str) -> Price | None:
        """The one place model prices are looked up (cost, spend limit, fail-closed check).

        An explicit `pricePer1kTokens` in config/ai-models.json wins; otherwise LiteLLM's model
        cost map for vendor APIs and aggregators (USD); otherwise None.
        """
        allowed = self.registry.get((provider, model))
        if allowed is None:
            return None
        if allowed.price is not None:
            return allowed.price
        cfg = self.configs.get(provider)
        found = price_from_litellm(cfg, model) if cfg else None
        return Price(found[0], found[1], "USD") if found else None

    async def _byo_route(self, org_id: str, purpose: str) -> _Route | None:
        """The org's own enabled provider for this purpose, if its plan includes BYO."""
        assert self.byo is not None
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", org_id)
            row = await conn.fetchrow(
                "select id::text as id, provider, base_url, api_key, models ->> $1 as model"
                " from ai_providers where enabled and models ? $1 order by created_at limit 1",
                purpose,
            )
            if row is None:
                return None
            if self.plans is not None and not await byo_allowed(conn, self.plans):
                return None  # e.g. downgraded: the operator's models serve the org again
        template = self.configs.get(row["provider"])
        try:
            if template is None:
                raise BlockedEndpoint(f"unknown provider {row['provider']!r}")
            if row["provider"] not in self.contour_providers:
                # The contour decides where data may go, for the org's own keys too.
                raise BlockedEndpoint(f"provider {row['provider']!r} is not in this contour")
            key = row["api_key"] and decrypt_secret(
                row["api_key"], f"{org_id}/{row['id']}", self.byo.keys
            )
            call = await byo_provider(
                template,
                base_url=row["base_url"],
                api_key=key or None,
                allowed=self.byo.allowed_networks,
            )
        except Exception as err:
            # The org chose its own provider: never send its data elsewhere instead.
            log.warning("org %s: own provider %s unusable: %s", org_id, row["id"], err)
            raise ProviderBlocked(
                "the organization's own AI provider cannot be used; check it in settings"
            ) from None
        return _Route(f"byo:{row['provider']}", row["model"], call, None)

    async def _call(
        self,
        route: _Route,
        purpose: str,
        messages: Sequence[Message],
        org_id: str,
        actor_id: str | None,
        prompt_template_id: str,
        prompt_template_version: str,
        max_tokens: int,
    ) -> LlmResult:
        provider, model, price = route.provider, route.model, route.price
        call_id = uuid.uuid4()
        now = datetime.now(UTC)
        prefix = f"{org_id}/{now:%Y/%m/%d}/{call_id}"
        request_key, response_key = f"{prefix}/request.json", f"{prefix}/response.json"
        await self.s3.put(
            request_key,
            _json(
                {
                    "purpose": purpose,
                    "provider": provider,
                    "model": model,
                    "max_tokens": max_tokens,
                    "prompt_template": {
                        "id": prompt_template_id,
                        "version": prompt_template_version,
                    },
                    "messages": [asdict(m) for m in messages],
                }
            ),
        )
        row: dict[str, Any] = {
            "id": call_id,
            "org_id": org_id,
            "actor_id": actor_id,
            "purpose": purpose,
            "provider": provider,
            "request_model": model,
            "prompt_template_id": prompt_template_id,
            "prompt_template_version": prompt_template_version,
            "request_key": request_key,
            "content_expires_at": now + self.retention,
            "contour": self.contour,
        }

        # OTel GenAI semantic conventions (client inference spans). gen_ai.system is the
        # deprecated name of gen_ai.provider.name; both are set so older backends map the span.
        attributes = {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": provider,
            "gen_ai.system": provider,
            "gen_ai.request.model": model,
            "gen_ai.request.max_tokens": max_tokens,
            # Opt-in *_ref attributes point at the stored content without copying it.
            "gen_ai.input.messages_ref": f"s3://{self.s3.bucket}/{request_key}",
            "app.ai.purpose": purpose,
            "app.ai.call_id": str(call_id),
            "app.ai.contour": self.contour,
        }
        with tracer.start_as_current_span(
            f"chat {model}", kind=SpanKind.CLIENT, attributes=attributes
        ) as span:
            ctx = span.get_span_context()
            if ctx.is_valid:
                row["trace_id"], row["span_id"] = f"{ctx.trace_id:032x}", f"{ctx.span_id:016x}"
            started = time.perf_counter()
            try:
                completion = await route.call(model, messages, max_tokens)
            except Exception as err:
                # Class name only: provider error messages can echo request content.
                span.set_attribute("error.type", type(err).__qualname__)
                span.set_status(Status(StatusCode.ERROR))
                row |= {
                    "latency_ms": _ms(started),
                    "status": "error",
                    "error_class": type(err).__qualname__,
                }
                await self._insert(row)
                if self.posthog:
                    await self.posthog.capture_generation(row, messages, None)
                raise
            row["latency_ms"] = _ms(started)

            for key, value in {
                "gen_ai.response.model": completion.model,
                "gen_ai.response.id": completion.response_id,
                "gen_ai.usage.input_tokens": completion.input_tokens,
                "gen_ai.usage.output_tokens": completion.output_tokens,
            }.items():
                if value is not None:
                    span.set_attribute(key, value)

            try:
                await self.s3.put(
                    response_key, _json({"text": completion.text, **_meta(completion)})
                )
                row["response_key"] = response_key
                span.set_attribute(
                    "gen_ai.output.messages_ref", f"s3://{self.s3.bucket}/{response_key}"
                )
            except Exception:  # the call happened: keep its row even without the content
                log.exception("ai call %s: storing response content failed", call_id)

            tokens_in, tokens_out = completion.input_tokens, completion.output_tokens
            total = (
                tokens_in + tokens_out if tokens_in is not None and tokens_out is not None else None
            )
            row |= {
                "response_model": completion.model,
                "input_tokens": tokens_in,
                "output_tokens": tokens_out,
                "total_tokens": total,
                "status": "ok",
            }
            if price and tokens_in is not None and tokens_out is not None:
                row["cost"] = (tokens_in * price.input + tokens_out * price.output) / 1000
                row["cost_currency"] = price.currency
            await self._insert(row)
        if self.posthog:
            await self.posthog.capture_generation(row, messages, completion.text)
        return LlmResult(call_id, completion.text)

    async def _insert(self, row: dict[str, Any]) -> None:
        # An org's own provider can name any model: one label value for all of them.
        byo = str(row["provider"]).startswith("byo:")
        model = {"purpose": row["purpose"], "model": "byo" if byo else row["request_model"]}
        calls_counter.add(1, {**model, "provider": row["provider"], "status": row["status"]})
        latency_histogram.record(row["latency_ms"] / 1000, model)
        if row.get("cost") is not None and row.get("cost_currency") == "USD":
            cost_counter.add(float(row["cost"]), model)
        columns = list(row)
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", row["org_id"])
            await conn.execute(
                f"insert into ai_calls ({', '.join(columns)})"  # noqa: S608 - fixed column names
                f" values ({', '.join(f'${i + 1}' for i in range(len(columns)))})",
                *row.values(),
            )


def _ms(started: float) -> int:
    return round((time.perf_counter() - started) * 1000)


def _json(doc: dict[str, Any]) -> bytes:
    return json.dumps(doc, ensure_ascii=False).encode()


def _meta(c: Completion) -> dict[str, Any]:
    return {
        "model": c.model,
        "id": c.response_id,
        "usage": {"input_tokens": c.input_tokens, "output_tokens": c.output_tokens},
    }

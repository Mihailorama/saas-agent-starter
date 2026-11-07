"""AI gateway: every LLM call goes through `Gateway.call_llm` (see docs/adr/0008-ai-layer.md).

Per call it checks the model registry (config/ai-models.json) for the current contour, stores
the request and response content as S3 objects, emits one OpenTelemetry span with GenAI
semantic-convention attributes (never prompt content), and appends one `ai_calls` row.
"""

import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from functools import cache
from pathlib import Path
from typing import Any, Literal

import asyncpg
from anthropic import AsyncAnthropic, omit
from anthropic.types import AssistantMessageParam, MessageParam, TextBlock, UserMessageParam
from openai import AsyncOpenAI
from openai.types.chat import (
    ChatCompletionAssistantMessageParam,
    ChatCompletionMessageParam,
    ChatCompletionSystemMessageParam,
    ChatCompletionUserMessageParam,
)
from opentelemetry import metrics, trace
from opentelemetry.trace import SpanKind, Status, StatusCode
from temporalio.exceptions import ApplicationError

from worker import settings
from worker.billing import Plans, check_llm_budget, ensure_org_active
from worker.posthog import PostHogAi
from worker.s3 import S3

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


@dataclass(frozen=True)
class LlmResult:
    call_id: uuid.UUID
    text: str


# (model, messages, max_tokens) -> Completion
Provider = Callable[[str, Sequence[Message], int], Awaitable[Completion]]


@dataclass(frozen=True)
class Price:
    input: Decimal  # per 1,000 tokens
    output: Decimal
    currency: str


@dataclass(frozen=True)
class AllowedModel:
    purposes: frozenset[str]
    price: Price | None
    # Explicit opt-out from cost tracking and LLM spend limits; an unpriced model without it
    # is refused (fail closed, docs/billing.md).
    unmetered: bool = False


Registry = dict[tuple[str, str], AllowedModel]  # (provider, model) -> rules


def load_registry(path: Path, contour: str) -> Registry:
    """Allowed models for one contour. Fails loudly on an unknown contour."""
    contours: dict[str, list[dict[str, Any]]] = json.loads(path.read_text())["contours"]
    if contour not in contours:
        raise ValueError(f"contour {contour!r} is not in {path} (have: {sorted(contours)})")
    registry: Registry = {}
    for entry in contours[contour]:
        p: dict[str, Any] | None = entry["pricePer1kTokens"]
        price = (
            Price(Decimal(str(p["input"])), Decimal(str(p["output"])), str(p["currency"]))
            if p
            else None
        )
        purposes: list[str] = entry["purposes"]
        registry[(str(entry["provider"]), str(entry["model"]))] = AllowedModel(
            frozenset(purposes), price, entry.get("unmetered") is True
        )
    return registry


class ModelNotAllowed(ApplicationError):
    def __init__(self, message: str) -> None:
        super().__init__(message, type="ModelNotAllowed", non_retryable=True)


class Gateway:
    def __init__(
        self,
        *,
        pool: asyncpg.Pool,
        s3: S3,
        contour: str,
        registry: Registry,
        providers: dict[str, Provider],
        retention_days: int,
        posthog: PostHogAi | None = None,
        plans: Plans | None = None,
    ) -> None:
        self.pool, self.s3, self.contour = pool, s3, contour
        self.posthog, self.plans = posthog, plans
        self.registry, self.providers = registry, providers
        self.retention = timedelta(days=retention_days)

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

        Raises ModelNotAllowed (non-retryable) if (provider, model, purpose) is not registered
        for this contour, SpendLimitExceeded (non-retryable) if the org's LLM spend in this
        billing period reached its plan limit; provider errors are logged as status=error and
        re-raised. A model without a price is refused unless it is marked `unmetered`; unmetered
        calls are not counted against the limit.
        """
        allowed = self.registry.get((provider, model))
        call = self.providers.get(provider)
        if allowed is None or purpose not in allowed.purposes or call is None:
            raise ModelNotAllowed(
                f"{provider}/{model} is not allowed for {purpose!r} in contour {self.contour!r}"
            )
        price = self.price_of(provider, model)
        if price is None and not allowed.unmetered:
            # No price, no cost, no spend limit: refuse rather than let calls through unbilled.
            raise ModelNotAllowed(
                f"{provider}/{model} has no price in the model registry; set pricePer1kTokens"
                ' or mark it "unmetered": true'
            )

        async with self.pool.acquire() as conn:
            await ensure_org_active(conn, org_id)
        if self.plans is not None and price is not None:
            await check_llm_budget(self.pool, self.plans, org_id, price.currency)

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
                completion = await call(model, messages, max_tokens)
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

    def price_of(self, provider: str, model: str) -> Price | None:
        """The one place model prices are looked up (cost, spend limit, fail-closed check).

        Today: config/ai-models.json for this contour. Swap the source here (e.g. a pricing
        table from an LLM proxy) without touching the callers.
        """
        allowed = self.registry.get((provider, model))
        return allowed.price if allowed else None

    async def _insert(self, row: dict[str, Any]) -> None:
        model = {"purpose": row["purpose"], "model": row["request_model"]}
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


# Providers. Clients are created on first use; keys come from ANTHROPIC_API_KEY/OPENAI_API_KEY.


@cache
def _anthropic() -> AsyncAnthropic:
    return AsyncAnthropic()


@cache
def _openai() -> AsyncOpenAI:
    return AsyncOpenAI(base_url=settings.OPENAI_BASE_URL or None)


async def anthropic_chat(model: str, messages: Sequence[Message], max_tokens: int) -> Completion:
    system = "\n\n".join(m.content for m in messages if m.role == "system")
    params: list[MessageParam] = [
        UserMessageParam(role="user", content=m.content)
        if m.role == "user"
        else AssistantMessageParam(role="assistant", content=m.content)
        for m in messages
        if m.role != "system"
    ]
    res = await _anthropic().messages.create(
        model=model, max_tokens=max_tokens, system=system or omit, messages=params
    )
    text = "".join(b.text for b in res.content if isinstance(b, TextBlock))
    return Completion(text, res.model, res.usage.input_tokens, res.usage.output_tokens, res.id)


def _openai_message(m: Message) -> ChatCompletionMessageParam:
    if m.role == "system":
        return ChatCompletionSystemMessageParam(role="system", content=m.content)
    if m.role == "user":
        return ChatCompletionUserMessageParam(role="user", content=m.content)
    return ChatCompletionAssistantMessageParam(role="assistant", content=m.content)


async def openai_compatible_chat(
    model: str, messages: Sequence[Message], max_tokens: int
) -> Completion:
    res = await _openai().chat.completions.create(
        model=model, max_tokens=max_tokens, messages=[_openai_message(m) for m in messages]
    )
    usage = res.usage
    return Completion(
        res.choices[0].message.content or "" if res.choices else "",
        res.model,
        usage.prompt_tokens if usage else None,
        usage.completion_tokens if usage else None,
        res.id,
    )


PROVIDERS: dict[str, Provider] = {
    "anthropic": anthropic_chat,
    "openai_compatible": openai_compatible_chat,
}

"""AI gateway: every LLM call goes through `Gateway.call_llm` (see docs/adr/0008-ai-layer.md).

Per call it checks the model registry (config/ai-models.json) for the current contour, routes
to the organization's own provider if it brought one (BYO), applies the plan's money limit
(priced models) or calls/tokens limit (unmetered models), stores the request and response
content as S3 objects, emits one OpenTelemetry span with GenAI semantic-convention attributes
(never prompt content), and appends one `ai_calls` row. Providers: worker/providers.py.
A call may opt in to the organization's MCP tools (worker/mcp.py): a bounded tool loop where
every tool call is its own `ai_calls` row with its arguments and result in S3.
"""

import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any, TypeVar

import asyncpg
from opentelemetry import metrics, trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode
from temporalio.exceptions import ApplicationError

from worker.billing import (
    Plans,
    byo_allowed,
    check_llm_budget,
    check_llm_usage,
    ensure_org_active,
)
from worker.credits import Credits, check_credit_balance
from worker.flags import is_enabled
from worker.mcp import McpConfig, Toolbox, ToolResult, toolbox
from worker.posthog import PostHogAi
from worker.providers import (
    BlockedEndpoint,
    Network,
    ProviderConfig,
    ToolCall,
    ToolSpec,
    byo_provider,
    is_rate_limited,
    message_dict,
    price_from_litellm,
)
from worker.providers import Completion as Completion
from worker.providers import Message as Message
from worker.providers import Provider as Provider
from worker.s3 import S3
from worker.webhooks import decrypt_secret

log = logging.getLogger(__name__)
T = TypeVar("T")
tracer = trace.get_tracer("worker.ai")
meter = metrics.get_meter("worker.ai")
# Names and labels agreed with the Grafana "LLM" dashboard and alerts (AGENTS.md "Observability").
# Labels are low-cardinality only, never ids or content.
calls_counter = meter.create_counter("ai_calls", description="LLM calls by outcome")
latency_histogram = meter.create_histogram(
    "ai_call_latency_seconds", description="LLM call latency in seconds"
)
cost_counter = meter.create_counter("ai_cost_usd", description="LLM cost in USD")
# MCP tool calls (worker/mcp.py); labels purpose and status only.
tool_counter = meter.create_counter("ai_tool_calls", description="MCP tool calls by outcome")


@dataclass(frozen=True)
class LlmResult:
    call_id: uuid.UUID
    text: str
    tool_calls: tuple[ToolCall, ...] = ()


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


class ToolLoopLimit(ApplicationError):
    def __init__(self, message: str) -> None:
        super().__init__(message, type="ToolLoopLimit", non_retryable=True)


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
        mcp: McpConfig | None = None,
        credits: Mapping[str, Credits] | None = None,
    ) -> None:
        self.pool, self.s3, self.contour = pool, s3, contour
        self.posthog, self.plans, self.byo, self.mcp = posthog, plans, byo, mcp
        self.credits: dict[str, Credits] = dict(credits or {})  # provider id -> adapter
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
        mcp_tools: bool = False,
    ) -> LlmResult:
        """One LLM call, logged. The span joins the current OTel trace (Temporal propagates it).

        If the org brought its own provider for `purpose` (flag `byo-llm-providers` on, its plan
        allows it, the provider listed for this contour), that one is called instead, without
        plan limits (the org pays its provider). Otherwise raises
        ModelNotAllowed (non-retryable) if (provider, model, purpose) is not registered for
        this contour or has no price and is not `unmetered`, SpendLimitExceeded /
        UsageLimitExceeded (non-retryable) at the plan's limit. A rate-limited call (429) is
        retried once per configured `fallback`; every attempt gets its own ai_calls row.
        Provider errors are logged as status=error and re-raised. OrgSuspended (non-retryable)
        for an organization an operator suspended.

        `mcp_tools=True` (flag `mcp-tools` on, MCP configured) offers the model the allowed tools
        of the org's MCP servers that list `purpose`, for up to McpConfig.max_iterations turns;
        the last turn offers none, so the model must answer (one that asks anyway raises
        ToolLoopLimit, non-retryable). Each turn and each tool call is its own ai_calls row.
        """
        # A suspended org (docs/admin.md) gets no call, its own provider included.
        async with self.pool.acquire() as conn:
            await ensure_org_active(conn, org_id)
        args = (purpose, model, provider, org_id, actor_id, prompt_template_id)
        if (
            not mcp_tools
            or self.mcp is None
            or not await is_enabled("mcp-tools", user_id=actor_id or org_id, org_id=org_id)
        ):
            return await self._llm(*args, prompt_template_version, max_tokens, messages, ())
        # One trace for the whole loop: its model calls and tool calls are child spans.
        loop = {"gen_ai.operation.name": "invoke_agent", "app.ai.purpose": purpose}
        with tracer.start_as_current_span(f"invoke_agent {purpose}", attributes=loop):
            box = await toolbox(self.pool, org_id, purpose, self.mcp)
            history, turn = list(messages), 1
            while True:
                # The last turn offers no tools: the model answers with what it has.
                last = turn >= self.mcp.max_iterations
                tools = () if last else box.specs
                res = await self._llm(*args, prompt_template_version, max_tokens, history, tools)
                if not res.tool_calls:
                    return res
                if last:  # asked for tools although none were offered
                    raise ToolLoopLimit(f"the model still asked for tools after {turn} turns")
                history.append(Message("assistant", res.text, tool_calls=res.tool_calls))
                for tc in res.tool_calls:
                    text = await self._tool(box, tc, res.call_id, purpose, org_id, actor_id)
                    history.append(Message("tool", text, tool_call_id=tc.id))
                turn += 1

    async def _llm(
        self,
        purpose: str,
        model: str,
        provider: str,
        org_id: str,
        actor_id: str | None,
        prompt_template_id: str,
        prompt_template_version: str,
        max_tokens: int,
        messages: Sequence[Message],
        tools: Sequence[ToolSpec],
    ) -> LlmResult:
        """Routing (BYO, registry, plan limits, fallback) and the logged call."""
        args = (
            purpose,
            messages,
            org_id,
            actor_id,
            prompt_template_id,
            prompt_template_version,
            max_tokens,
            tools,
        )
        byo = self.byo is not None and await is_enabled(
            "byo-llm-providers", user_id=actor_id or org_id, org_id=org_id
        )
        own = await self._byo_route(org_id, purpose) if byo else None
        if own is not None:
            return await self._call(own, *args)
        tried: set[tuple[str, str]] = set()
        while True:
            allowed, route = self._route(purpose, provider, model)
            if self.plans is not None:
                if route.price is not None:
                    await check_llm_budget(self.pool, self.plans, org_id, route.price.currency)
                    if self.credits:
                        await check_credit_balance(self.pool, self.plans, self.credits, org_id)
                else:
                    await check_llm_usage(self.pool, self.plans, org_id, self.unmetered)
            try:
                return await self._call(route, *args)
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

    async def _logged(
        self,
        row: dict[str, Any],
        request: dict[str, Any],
        span_name: str,
        attributes: dict[str, Any],
        work: Callable[[], Awaitable[T]],
        finish: Callable[[T, Span], dict[str, Any]],
        write: Callable[[dict[str, Any]], Awaitable[None]],
    ) -> T:
        """Every ai_calls record: request content in S3, one span, the timed `work`, `finish`
        (fills the row, returns the response content for S3), the row; on failure the row with
        the error class, then re-raised. Spans get content references, never content."""
        now = datetime.now(UTC)
        prefix = f"{row['org_id']}/{now:%Y/%m/%d}/{row['id']}"
        row |= {
            "request_key": f"{prefix}/request.json",
            "content_expires_at": now + self.retention,
            "contour": self.contour,
        }
        await self.s3.put(row["request_key"], _json(request))
        attributes |= {
            # Opt-in *_ref attributes point at the stored content without copying it.
            "gen_ai.input.messages_ref": f"s3://{self.s3.bucket}/{row['request_key']}",
            "app.ai.purpose": row["purpose"],
            "app.ai.call_id": str(row["id"]),
            "app.ai.contour": self.contour,
        }
        with tracer.start_as_current_span(
            span_name, kind=SpanKind.CLIENT, attributes=attributes
        ) as span:
            ctx = span.get_span_context()
            if ctx.is_valid:
                row["trace_id"], row["span_id"] = f"{ctx.trace_id:032x}", f"{ctx.span_id:016x}"
            started = time.perf_counter()
            try:
                result = await work()
            except Exception as err:
                # Class name only: error messages can echo request content.
                span.set_attribute("error.type", type(err).__qualname__)
                span.set_status(Status(StatusCode.ERROR))
                row |= {
                    "latency_ms": _ms(started),
                    "status": "error",
                    "error_class": type(err).__qualname__,
                }
                await write(row)
                raise
            row["latency_ms"] = _ms(started)
            response = finish(result, span)
            key = f"{prefix}/response.json"
            try:
                await self.s3.put(key, _json(response))
                row["response_key"] = key
                span.set_attribute("gen_ai.output.messages_ref", f"s3://{self.s3.bucket}/{key}")
            except Exception:  # it happened: keep its row even without the content
                log.exception("ai call %s: storing response content failed", row["id"])
            await write(row)
        return result

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
        tools: Sequence[ToolSpec],
    ) -> LlmResult:
        provider, model, price = route.provider, route.model, route.price
        row: dict[str, Any] = {
            "id": uuid.uuid4(),
            "org_id": org_id,
            "actor_id": actor_id,
            "purpose": purpose,
            "provider": provider,
            "request_model": model,
            "prompt_template_id": prompt_template_id,
            "prompt_template_version": prompt_template_version,
        }
        request = {
            "purpose": purpose,
            "provider": provider,
            "model": model,
            "max_tokens": max_tokens,
            "prompt_template": {"id": prompt_template_id, "version": prompt_template_version},
            "messages": [message_dict(m) for m in messages],
            **({"tools": list(tools)} if tools else {}),
        }
        # OTel GenAI semantic conventions (client inference spans). gen_ai.system is the
        # deprecated name of gen_ai.provider.name; both are set so older backends map the span.
        attributes: dict[str, Any] = {
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": provider,
            "gen_ai.system": provider,
            "gen_ai.request.model": model,
            "gen_ai.request.max_tokens": max_tokens,
        }

        def finish(c: Completion, span: Span) -> dict[str, Any]:
            for key, value in {
                "gen_ai.response.model": c.model,
                "gen_ai.response.id": c.response_id,
                "gen_ai.usage.input_tokens": c.input_tokens,
                "gen_ai.usage.output_tokens": c.output_tokens,
            }.items():
                if value is not None:
                    span.set_attribute(key, value)
            tokens_in, tokens_out = c.input_tokens, c.output_tokens
            total = (
                tokens_in + tokens_out if tokens_in is not None and tokens_out is not None else None
            )
            row.update(
                response_model=c.model,
                input_tokens=tokens_in,
                output_tokens=tokens_out,
                total_tokens=total,
                status="ok",
            )
            if price and tokens_in is not None and tokens_out is not None:
                row["cost"] = (tokens_in * price.input + tokens_out * price.output) / 1000
                row["cost_currency"] = price.currency
            return _response(c)

        try:
            completion = await self._logged(
                row,
                request,
                f"chat {model}",
                attributes,
                lambda: route.call(model, messages, max_tokens, tools),
                finish,
                self._insert,
            )
        except Exception:
            if self.posthog and "status" in row:
                await self.posthog.capture_generation(row, messages, None)
            raise
        if self.posthog:
            await self.posthog.capture_generation(row, messages, completion.text)
        return LlmResult(row["id"], completion.text, completion.tool_calls)

    async def _tool(
        self,
        box: Toolbox,
        call: ToolCall,
        llm_call_id: uuid.UUID,
        purpose: str,
        org_id: str,
        actor_id: str | None,
    ) -> str:
        """One tool call the model asked for, logged as its own ai_calls row; returns what the
        model sees. A tool that is not offered is never called; every failure (the server
        unreachable or gone mid-loop included) goes back to the model as a tool error."""
        server = box.servers.get(call.name)
        name = call.name if server else "unknown"  # model-chosen names are content until checked
        row: dict[str, Any] = {
            "id": uuid.uuid4(),
            "org_id": org_id,
            "actor_id": actor_id,
            "purpose": purpose,
            "provider": f"mcp:{server.name}" if server else "mcp",
            "request_model": name,
            "prompt_template_id": "mcp.tool",
            "prompt_template_version": "1",
        }
        request = {
            "purpose": purpose,
            "llm_call_id": str(llm_call_id),
            "server_id": server and server.id,
            "tool": call.name,
            "tool_call_id": call.id,
            "arguments": call.arguments,
        }

        async def work() -> ToolResult:
            if server is None:
                raise ToolNotOffered
            return await box.call(call)

        def finish(r: ToolResult, _: Span) -> dict[str, Any]:
            row["status"] = "error" if r.is_error else "ok"
            if r.is_error:
                row["error_class"] = "ToolResultError"
            return {"result": r.content}

        async def write(r: dict[str, Any]) -> None:
            tool_counter.add(1, {"purpose": purpose, "status": r["status"]})
            await self._write(r)

        attributes: dict[str, Any] = {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": name,
            "app.ai.llm_call_id": str(llm_call_id),
        }
        try:
            result = await self._logged(
                row, request, f"execute_tool {name}", attributes, work, finish, write
            )
        except Exception as err:
            return f"tool error: {type(err).__qualname__}"
        return result.text

    async def _insert(self, row: dict[str, Any]) -> None:
        # An org's own provider can name any model: one label value for all of them.
        byo = str(row["provider"]).startswith("byo:")
        model = {"purpose": row["purpose"], "model": "byo" if byo else row["request_model"]}
        calls_counter.add(1, {**model, "provider": row["provider"], "status": row["status"]})
        latency_histogram.record(row["latency_ms"] / 1000, model)
        if row.get("cost") is not None and row.get("cost_currency") == "USD":
            cost_counter.add(float(row["cost"]), model)
        await self._write(row)

    async def _write(self, row: dict[str, Any]) -> None:
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


def _response(c: Completion) -> dict[str, Any]:
    out: dict[str, Any] = {
        "text": c.text,
        "model": c.model,
        "id": c.response_id,
        "usage": {"input_tokens": c.input_tokens, "output_tokens": c.output_tokens},
    }
    if c.tool_calls:
        out["tool_calls"] = [asdict(t) for t in c.tool_calls]
    return out


class ToolNotOffered(Exception):
    """The model named a tool this call did not offer (not allowed, or no such tool)."""

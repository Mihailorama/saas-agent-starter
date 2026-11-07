"""Feature flags (docs/feature-flags.md, ADR 0020): the worker twin of apps/api/src/flags.ts.

Call ``is_enabled`` with a literal flag name from config/flags.json plus ``user_id`` and
optionally ``org_id`` / ``plan``. Order: FLAGS_ON / FLAGS_OFF env, then PostHog (when
POSTHOG_KEY is set; the organization is the ``organization`` group), then the catalog default.

PostHog is asked through the official ``posthog`` SDK, like ``posthog-node`` in the API: remote
evaluation with the project key, or local evaluation (definitions polled every 30 s) when
POSTHOG_SECRET_KEY is set. Each answered check sends a ``$feature_flag_called`` exposure event.
The SDK is synchronous, so a check runs in a thread and never blocks the event loop.
"""

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
from functools import cache

from posthog import Posthog

from worker import settings

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class FlagContext:
    user_id: str
    org_id: str | None = None
    plan: str | None = None


# Remote decision for one flag; None = no answer (unknown, inactive, network error).
Remote = Callable[[str, FlagContext], Awaitable[bool | None]]


async def evaluate(
    flag: str,
    ctx: FlagContext,
    *,
    defaults: dict[str, bool],
    on: Collection[str] = (),
    off: Collection[str] = (),
    remote: Remote | None = None,
) -> bool:
    if flag not in defaults:
        raise KeyError(f"unknown feature flag {flag!r}: add it to config/flags.json")
    if flag in on:
        return True
    if flag in off:
        return False
    value: bool | None = None
    if remote is not None:
        try:
            value = await remote(flag, ctx)
        except Exception:
            log.warning("feature flag %s: PostHog evaluation failed, using the default", flag)
    return defaults[flag] if value is None else value


def posthog_remote(client: Posthog) -> Remote:
    """PostHog decision: the user is the person, the organization a group (`organization`)."""

    def decide(flag: str, ctx: FlagContext) -> bool | None:
        groups = {"organization": ctx.org_id} if ctx.org_id else None
        props = {"organization": {"plan": ctx.plan}} if groups and ctx.plan else None
        flags = client.evaluate_flags(
            ctx.user_id, flag_keys=[flag], groups=groups, group_properties=props
        )
        value = flags.get_flag(flag)  # also queues the $feature_flag_called exposure event
        return None if value is None else bool(value)  # a variant string counts as on

    async def remote(flag: str, ctx: FlagContext) -> bool | None:
        return await asyncio.to_thread(decide, flag, ctx)

    return remote


@cache
def _client() -> Posthog | None:
    if not settings.POSTHOG_KEY:
        return None
    return Posthog(
        settings.POSTHOG_KEY,
        host=settings.POSTHOG_HOST or None,  # None = the SDK's US default
        secret_key=settings.POSTHOG_SECRET_KEY or None,
    )


@cache
def _setup() -> tuple[dict[str, bool], Remote | None]:
    catalog: dict[str, dict[str, object]] = json.loads(settings.FLAGS_FILE.read_text())["flags"]
    defaults = {name: spec["default"] is True for name, spec in catalog.items()}
    client = _client()
    return defaults, client and posthog_remote(client)


def close() -> None:
    """Sends queued exposure events and stops the poller; called on worker shutdown."""
    if _client.cache_info().currsize and (client := _client()):
        client.shutdown()


async def is_enabled(
    flag: str, *, user_id: str, org_id: str | None = None, plan: str | None = None
) -> bool:
    defaults, remote = _setup()
    return await evaluate(
        flag,
        FlagContext(user_id, org_id, plan),
        defaults=defaults,
        on=settings.FLAGS_ON,
        off=settings.FLAGS_OFF,
        remote=remote,
    )

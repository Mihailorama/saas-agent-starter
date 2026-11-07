"""Feature flags (docs/feature-flags.md, ADR 0020): the worker twin of apps/api/src/flags.ts.

Call ``is_enabled`` with a literal flag name from config/flags.json plus ``user_id`` and
optionally ``org_id`` / ``plan``. Order: FLAGS_ON / FLAGS_OFF env, then PostHog (when
POSTHOG_KEY is set; the organization is the ``organization`` group), then the catalog default.

PostHog is asked through its public ``/flags?v=2`` endpoint with the project key (remote
evaluation, one request per check): the ``posthog`` PyPI SDK pulls a dependency the license gate
does not accept yet (docs/feature-flags.md).
"""

import json
import logging
from collections.abc import Awaitable, Callable, Collection
from dataclasses import dataclass
from functools import cache
from typing import Any

import httpx2

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


def posthog_remote(key: str, host: str, http: httpx2.AsyncClient) -> Remote:
    async def remote(flag: str, ctx: FlagContext) -> bool | None:
        body: dict[str, Any] = {"api_key": key, "distinct_id": ctx.user_id}
        if ctx.org_id:
            body["groups"] = {"organization": ctx.org_id}
            if ctx.plan:
                body["group_properties"] = {"organization": {"plan": ctx.plan}}
        res = await http.post(f"{host}/flags?v=2", json=body)
        res.raise_for_status()
        result: dict[str, Any] | None = res.json().get("flags", {}).get(flag)
        return None if result is None else bool(result.get("enabled"))

    return remote


@cache
def _setup() -> tuple[dict[str, bool], Remote | None]:
    catalog: dict[str, dict[str, object]] = json.loads(settings.FLAGS_FILE.read_text())["flags"]
    defaults = {name: spec["default"] is True for name, spec in catalog.items()}
    if not settings.POSTHOG_KEY:
        return defaults, None
    host = (settings.POSTHOG_HOST or "https://us.i.posthog.com").rstrip("/")
    return defaults, posthog_remote(settings.POSTHOG_KEY, host, httpx2.AsyncClient(timeout=3))


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

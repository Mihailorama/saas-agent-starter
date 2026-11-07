from typing import Any

import posthog.client
import pytest
from posthog import Posthog

from worker.flags import FlagContext, evaluate, posthog_remote

DEFAULTS = {"new-form": False, "old-form": True}
CTX = FlagContext("u1", "o1", "pro")


async def answers(flag: str, ctx: FlagContext) -> bool | None:
    return {"new-form": True, "old-form": False}.get(flag)


async def no_answer(flag: str, ctx: FlagContext) -> bool | None:
    return None


async def failing(flag: str, ctx: FlagContext) -> bool | None:
    raise TimeoutError


async def test_without_posthog_the_catalog_default() -> None:
    assert await evaluate("new-form", CTX, defaults=DEFAULTS) is False
    assert await evaluate("old-form", CTX, defaults=DEFAULTS) is True


async def test_posthog_answer_wins_and_no_answer_falls_back() -> None:
    assert await evaluate("new-form", CTX, defaults=DEFAULTS, remote=answers) is True
    assert await evaluate("old-form", CTX, defaults=DEFAULTS, remote=answers) is False
    assert await evaluate("old-form", CTX, defaults=DEFAULTS, remote=no_answer) is True
    assert await evaluate("old-form", CTX, defaults=DEFAULTS, remote=failing) is True


async def test_env_override_beats_default_and_posthog() -> None:
    on, off = {"new-form"}, {"old-form"}
    assert await evaluate("new-form", CTX, defaults=DEFAULTS, on=on, off=off, remote=no_answer)
    assert not await evaluate("old-form", CTX, defaults=DEFAULTS, on=on, off=off, remote=answers)


async def test_unknown_flag_is_an_error() -> None:
    with pytest.raises(KeyError, match=r"config/flags\.json"):
        await evaluate("typo", CTX, defaults=DEFAULTS)


async def test_posthog_sdk_gets_user_org_group_and_plan_and_sends_exposures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[dict[str, Any]] = []
    events: list[tuple[str, dict[str, Any]]] = []

    def flags(api_key: str, host: str, **body: Any) -> dict[str, Any]:
        assert (api_key, host) == ("phc_example", "https://eu.i.posthog.com")
        sent.append(body)
        found = {"new-form": {"key": "new-form", "enabled": True, "variant": "b"}}
        return {"flags": {k: v for k, v in found.items() if k in body["flag_keys_to_evaluate"]}}

    def capture(event: str, **kw: Any) -> None:
        events.append((event, kw))

    monkeypatch.setattr(posthog.client, "flags", flags)
    client = Posthog("phc_example", host="https://eu.i.posthog.com")
    monkeypatch.setattr(client, "capture", capture)
    remote = posthog_remote(client)

    assert await remote("new-form", CTX) is True  # a variant counts as on
    assert await remote("old-form", FlagContext("u2")) is None  # PostHog does not know it
    assert [(b["distinct_id"], b["groups"], b["group_properties"]) for b in sent] == [
        ("u1", {"organization": "o1"}, {"organization": {"$group_key": "o1", "plan": "pro"}}),
        ("u2", {}, {}),
    ]
    assert [b["flag_keys_to_evaluate"] for b in sent] == [["new-form"], ["old-form"]]
    exposure = [(e, kw["distinct_id"], kw["properties"]["$feature_flag"]) for e, kw in events]
    assert exposure[0] == ("$feature_flag_called", "u1", "new-form")

import json

import httpx2
import pytest

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


async def test_posthog_request_has_user_org_group_and_plan() -> None:
    sent: list[dict[str, object]] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        assert str(request.url) == "https://eu.i.posthog.com/flags?v=2"
        sent.append(json.loads(request.content))
        flags = {"new-form": {"key": "new-form", "enabled": True, "variant": "b"}}
        return httpx2.Response(200, json={"flags": flags})

    http = httpx2.AsyncClient(transport=httpx2.MockTransport(handler))
    remote = posthog_remote("phc_example", "https://eu.i.posthog.com", http)
    assert await remote("new-form", CTX) is True
    assert await remote("old-form", FlagContext("u2")) is None
    assert sent == [
        {
            "api_key": "phc_example",
            "distinct_id": "u1",
            "groups": {"organization": "o1"},
            "group_properties": {"organization": {"plan": "pro"}},
        },
        {"api_key": "phc_example", "distinct_id": "u2"},
    ]

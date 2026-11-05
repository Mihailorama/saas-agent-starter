"""Provider adapters against canned HTTP responses (httpx2.MockTransport): no network.

Checks the request shape we send and the fields we read back, for the real SDKs.
"""

import json
from typing import Any

import httpx2
import pytest
from anthropic import AsyncAnthropic
from openai import AsyncOpenAI

from worker import ai
from worker.ai import Message

MESSAGES = [Message("system", "Be brief."), Message("user", "Hi")]


def transport(sent: list[dict[str, Any]], reply: dict[str, Any]) -> httpx2.AsyncClient:
    def handle(request: httpx2.Request) -> httpx2.Response:
        sent.append({"url": str(request.url), "body": json.loads(request.content)})
        return httpx2.Response(200, json=reply)

    return httpx2.AsyncClient(transport=httpx2.MockTransport(handle))


async def test_anthropic(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[dict[str, Any]] = []
    reply = {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-haiku-5-5",
        "content": [{"type": "text", "text": "Hello."}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 12, "output_tokens": 3},
    }
    client = AsyncAnthropic(api_key="test", http_client=transport(sent, reply))
    monkeypatch.setattr(ai, "_anthropic", lambda: client)

    completion = await ai.anthropic_chat("claude-haiku-5-5", MESSAGES, 64)

    assert completion == ai.Completion("Hello.", "claude-haiku-5-5", 12, 3, "msg_1")
    body = sent[0]["body"]
    assert sent[0]["url"].endswith("/v1/messages")
    assert (body["model"], body["max_tokens"], body["system"]) == (
        "claude-haiku-5-5",
        64,
        "Be brief.",
    )
    assert body["messages"] == [{"role": "user", "content": "Hi"}]


async def test_openai_compatible_uses_base_url(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[dict[str, Any]] = []
    reply = {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 0,
        "model": "example-self-hosted-model",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "Hello."},
            }
        ],
        "usage": {"prompt_tokens": 12, "completion_tokens": 3, "total_tokens": 15},
    }
    client = AsyncOpenAI(
        api_key="test",
        base_url="https://llm.example.com/v1",
        http_client=transport(sent, reply),
    )
    monkeypatch.setattr(ai, "_openai", lambda: client)

    completion = await ai.openai_compatible_chat("example-self-hosted-model", MESSAGES, 64)

    assert completion == ai.Completion("Hello.", "example-self-hosted-model", 12, 3, "chatcmpl-1")
    assert sent[0]["url"] == "https://llm.example.com/v1/chat/completions"
    assert sent[0]["body"]["messages"] == [
        {"role": "system", "content": "Be brief."},
        {"role": "user", "content": "Hi"},
    ]

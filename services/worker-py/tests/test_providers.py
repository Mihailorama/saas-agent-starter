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

import pytest

from worker import providers, settings
from worker.providers import (
    BlockedEndpoint,
    Completion,
    Message,
    ProviderConfig,
    byo_provider,
    load_providers,
    price_from_litellm,
    providers_from_config,
)

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
    # The shipped config reaches vendor APIs at their own hosts; point them at the mock.
    found["anthropic"] = replace(found["anthropic"], base_url=mock.url)
    found["gemini"] = replace(found["gemini"], base_url=mock.url)
    found["openrouter"] = replace(found["openrouter"], base_url=f"{mock.url}/api/v1")
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
        "/models/gemini-3.5-flash:generateContent",
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
    bad = tmp_path / "models.json"
    bad.write_text(json.dumps({"providers": {"x": {"kind": "magic"}}}))
    with pytest.raises(ValueError, match="unknown kind"):
        load_providers(bad, {}, cli_url="", cli_token="", timeout=1, cli_timeout=1)


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

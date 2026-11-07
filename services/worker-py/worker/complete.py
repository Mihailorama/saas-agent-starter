"""`python -m worker.complete --provider P --model M` with `{"system": ..., "prompt": ...}` on
stdin: one completion through the gateway's provider path (worker/providers.py), text on stdout.

For `pnpm eval:real` only (scripts/eval.mjs): golden-set inputs are synthetic, so nothing is
logged to ai_calls. The pair must be registered for the contour like in the gateway.
"""

import argparse
import asyncio
import json
import os
import sys

from worker import settings
from worker.ai import Message, load_registry
from worker.providers import load_providers, providers_from_config


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    args = parser.parse_args()
    contour = settings.AI_CONTOUR or "eu"
    if (args.provider, args.model) not in load_registry(settings.AI_MODELS_FILE, contour):
        sys.exit(f"{args.provider}/{args.model} is not registered in contour {contour}")
    configs = load_providers(
        settings.AI_MODELS_FILE,
        os.environ,
        cli_url=settings.LLM_CLI_URL,
        cli_token=settings.LLM_CLI_TOKEN,
        timeout=settings.AI_REQUEST_TIMEOUT_SECONDS,
        cli_timeout=settings.AI_CLI_TIMEOUT_SECONDS,
    )
    cfg = configs.get(args.provider)
    if cfg is None or not cfg.configured:
        sys.exit(f"provider {args.provider} is not configured (docs/llm-providers.md)")
    doc = json.load(sys.stdin)
    call = providers_from_config(configs)[args.provider]
    completion = await call(
        args.model, [Message("system", doc["system"]), Message("user", doc["prompt"])], 4096
    )
    sys.stdout.write(completion.text)


if __name__ == "__main__":
    asyncio.run(main())

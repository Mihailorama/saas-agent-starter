"""Post-deploy checks that a connected or installed component works (docs/setup.md, ADR 0032).

`pnpm run infra -- verify` runs them inside the worker container on the server:
  python -m worker.selfcheck s3            put, read back and delete one object in S3_BUCKET
  python -m worker.selfcheck smtp [to]     one test mail from MAIL_FROM (to MAIL_FROM by default)
  python -m worker.selfcheck llm [org_id]  a one-token call through Gateway.call_llm, purpose
                                           project.summary, the model of AI_PROJECT_SUMMARY_*
Prints one line, never a value or a reply. Exit 0 = ok, 1 = failed, 3 = skipped (not configured).
The LLM call is a real, logged call (ai_calls) billed to the organization given, or to
SUPPORT_AI_ORG_ID; a fresh install has none yet, so it is skipped until you pass one.
"""

import asyncio
import os
import sys
import uuid
from email.utils import parseaddr

import asyncpg

from worker import prompts, settings
from worker.activities import SUMMARY_PROMPT, SUMMARY_PURPOSE
from worker.ai import Gateway, Message, load_registry
from worker.billing import load_plans
from worker.mail import SendEmail, build_message, deliver, parse_smtp_url
from worker.providers import load_providers, providers_from_config
from worker.s3 import S3

SKIP = 3


class Skipped(Exception):
    pass


def _s3() -> S3:
    return S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=settings.S3_BUCKET,
    )


async def check_s3(s3: S3) -> str:
    key = f"selfcheck/{uuid.uuid4()}"
    body = uuid.uuid4().bytes
    await s3.ensure_bucket()
    await s3.put(key, body, "application/octet-stream")
    try:
        if await s3.get(key) != body:
            raise RuntimeError("read back a different object")
    finally:
        await s3.delete(key)
    return f"put, get and delete in bucket {s3.bucket}"


async def check_smtp(to: str | None) -> str:
    if not settings.SMTP_URL or not settings.MAIL_FROM:
        raise Skipped("SMTP_URL / MAIL_FROM not set")
    to = to or parseaddr(settings.MAIL_FROM)[1]
    email = SendEmail(
        kind="selfcheck",
        to=to,
        subject="Self-check: mail delivery works",
        html="<p>Sent by <code>python -m worker.selfcheck smtp</code>.</p>",
        text="Sent by python -m worker.selfcheck smtp.",
    )
    msg = build_message(email, settings.MAIL_FROM)
    await asyncio.to_thread(deliver, parse_smtp_url(settings.SMTP_URL), msg)
    return "test mail accepted by the SMTP server"


async def check_llm(ai: Gateway, org_id: str, provider: str, model: str) -> str:
    prompt = prompts.load(*SUMMARY_PROMPT)
    result = await ai.call_llm(
        SUMMARY_PURPOSE,
        [Message("system", prompt.text), Message("user", "Self-check. Answer: ok")],
        model=model,
        provider=provider,
        org_id=org_id,
        actor_id=None,
        prompt_template_id=prompt.id,
        prompt_template_version=prompt.version,
        max_tokens=1,
    )
    return f"{provider}/{model} answered (ai_calls {result.call_id})"


def _gateway(pool: asyncpg.Pool) -> Gateway:
    configs = load_providers(
        settings.AI_MODELS_FILE,
        os.environ,
        cli_url=settings.LLM_CLI_URL,
        cli_token=settings.LLM_CLI_TOKEN,
        timeout=settings.AI_REQUEST_TIMEOUT_SECONDS,
        cli_timeout=settings.AI_CLI_TIMEOUT_SECONDS,
    )
    s3 = S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=settings.AI_CONTENT_BUCKET,
    )
    return Gateway(
        pool=pool,
        s3=s3,
        contour=settings.AI_CONTOUR,
        registry=load_registry(settings.AI_MODELS_FILE, settings.AI_CONTOUR),
        providers=providers_from_config(configs),
        provider_configs=configs,
        retention_days=settings.AI_CONTENT_RETENTION_DAYS,
        plans=load_plans(settings.PLANS_FILE),
    )


async def run(check: str, arg: str | None) -> str:
    if check == "s3":
        s3 = _s3()
        try:
            return await check_s3(s3)
        finally:
            await s3.close()
    if check == "smtp":
        return await check_smtp(arg)
    if check == "llm":
        provider, model = settings.AI_PROJECT_SUMMARY_PROVIDER, settings.AI_PROJECT_SUMMARY_MODEL
        if not (settings.AI_CONTOUR and provider and model):
            raise Skipped("AI_CONTOUR / AI_PROJECT_SUMMARY_PROVIDER / _MODEL not set")
        org_id = arg or settings.SUPPORT_AI_ORG_ID
        if not org_id:
            raise Skipped("no organization: sign up, then `pnpm run infra -- verify --org <id>`")
        pool = await asyncpg.create_pool(settings.DATABASE_URL)
        try:
            ai = _gateway(pool)
            await ai.s3.ensure_bucket()
            return await check_llm(ai, org_id, provider, model)
        finally:
            await pool.close()
    raise SystemExit("usage: python -m worker.selfcheck s3 | smtp [to] | llm [org_id]")


def main(argv: list[str]) -> int:
    check, arg = [*argv, ""][0], (argv[1:] or [None])[0]
    try:
        print(f"{check}: ok, {asyncio.run(run(check, arg))}")
        return 0
    except Skipped as err:
        print(f"{check}: skipped, {err}")
        return SKIP
    except Exception as err:  # one line for the operator: the class only, never values
        print(f"{check}: FAILED, {type(err).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

import uuid
from collections.abc import AsyncIterator

import asyncpg
import pytest

from worker import settings
from worker.s3 import S3


@pytest.fixture(scope="session")
async def pool() -> AsyncIterator[asyncpg.Pool]:
    pool = await asyncpg.create_pool(settings.DATABASE_URL)
    yield pool
    await pool.close()


@pytest.fixture(scope="session")
async def s3() -> AsyncIterator[S3]:
    s3 = S3(
        endpoint=settings.S3_ENDPOINT,
        region=settings.S3_REGION,
        access_key=settings.S3_ACCESS_KEY_ID,
        secret_key=settings.S3_SECRET_ACCESS_KEY,
        bucket=settings.AI_CONTENT_BUCKET,
    )
    await s3.ensure_bucket()
    yield s3
    await s3.close()


async def new_org(pool: asyncpg.Pool) -> str:
    org_id = str(uuid.uuid4())
    await pool.execute(
        "insert into organization (id, name, slug, created_at) values ($1, $1, $1, now())", org_id
    )
    return org_id

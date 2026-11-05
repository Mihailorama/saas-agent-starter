import uuid
from collections.abc import AsyncIterator

import asyncpg
import pytest

from worker import settings


@pytest.fixture(scope="session")
async def pool() -> AsyncIterator[asyncpg.Pool]:
    pool = await asyncpg.create_pool(settings.DATABASE_URL)
    yield pool
    await pool.close()


async def new_org(pool: asyncpg.Pool) -> str:
    org_id = str(uuid.uuid4())
    await pool.execute(
        "insert into organization (id, name, slug, created_at) values ($1, $1, $1, now())", org_id
    )
    return org_id

"""Outbound webhooks: one delivery attempt per activity run, retried by Temporal with backoff.

Signed per Standard Webhooks (webhook-id / webhook-timestamp / webhook-signature, HMAC-SHA256
over `id.timestamp.body`) with the official `standardwebhooks` library. Before connecting, the
host is resolved and every address checked: private, loopback, link-local and other non-global
ranges are refused, then we connect to the
checked IP (Host header and TLS SNI keep the hostname), so DNS cannot swap the target between
check and connect. Redirects are not followed and response bodies are never read.

Signing secrets are stored encrypted (AES-256-GCM, `v1:<key id>:<iv>:<ciphertext+tag>`, bound
to the endpoint id); this module holds the only decryption code (the AI gateway uses it for
organization-owned provider keys, bound to org and row id). Twin of
apps/api/src/webhook-secret.ts, which only encrypts.
"""

import asyncio
import base64
import hashlib
import os
import socket
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network, ip_address
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import httpx2
from asyncpg.pool import PoolConnectionProxy
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from standardwebhooks import Webhook
from temporalio import activity
from temporalio.exceptions import ApplicationError

Network = IPv4Network | IPv6Network

# Default retry schedule (worker/workflows.py): 8 attempts, x3 backoff from 30 s, capped at 6 h,
# i.e. retries after ~30 s, 1.5 min, 4.5 min, 13.5 min, 40 min, 2 h, 6 h (about 9 h in total).
RETRY_INITIAL_SECONDS = 30.0
MAX_ATTEMPTS = 8

# Failures that a retry cannot fix: the delivery is marked failed at once.
PERMANENT = {
    "endpoint_disabled",
    "payload_too_large",
    "invalid_url",
    "blocked_address",
    "secret_unreadable",
    "org_suspended",  # an operator suspended the org (docs/admin.md); a replay resends it later
}


@dataclass(frozen=True)
class WebhookEvent:
    """Workflow input. Contract with apps/api/src/temporal.ts (camelCase JSON). Ids only: the
    payload is read from webhook_events, so no customer data lands in workflow history."""

    orgId: str
    eventId: str
    deliveryIds: list[str]
    replay: bool = False
    retryInitialSeconds: float = RETRY_INITIAL_SECONDS
    maxAttempts: int = MAX_ATTEMPTS


@dataclass(frozen=True)
class WebhookDelivery:
    orgId: str
    deliveryId: str
    replay: bool
    maxAttempts: int


class BlockedAddress(Exception):
    pass


def parse_keys(value: str) -> dict[str, bytes]:
    """WEBHOOK_ENCRYPTION_KEYS (`id:secret,...`) -> {id: AES key}; the first entry is active."""
    keys: dict[str, bytes] = {}
    for item in filter(None, (part.strip() for part in value.split(","))):
        key_id, _, secret = item.partition(":")
        keys[key_id] = hashlib.sha256(secret.encode()).digest()
    return keys


def encrypt_secret(secret: str, endpoint_id: str, key_id: str, key: bytes) -> str:
    iv = os.urandom(12)
    data = AESGCM(key).encrypt(iv, secret.encode(), endpoint_id.encode())
    return f"v1:{key_id}:{base64.b64encode(iv).decode()}:{base64.b64encode(data).decode()}"


def decrypt_secret(stored: str, endpoint_id: str, keys: Mapping[str, bytes]) -> str:
    """Raises KeyError (unknown key id), ValueError (format) or InvalidTag (wrong key / row)."""
    version, key_id, iv, data = stored.split(":")
    if version != "v1":
        raise ValueError("unknown secret format")
    plain = AESGCM(keys[key_id]).decrypt(
        base64.b64decode(iv), base64.b64decode(data), endpoint_id.encode()
    )
    return plain.decode()


def sign(secret: str, msg_id: str, timestamp: int, body: str) -> str:
    """One Standard Webhooks `v1` signature; `secret` is `whsec_<base64>`."""
    return Webhook(secret).sign(msg_id, datetime.fromtimestamp(timestamp, UTC), body)


def is_blocked(ip: IPv4Address | IPv6Address, allowed: Sequence[Network] = ()) -> bool:
    if isinstance(ip, IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    if any(ip in net for net in allowed):
        return False
    return not ip.is_global or ip.is_multicast


async def resolve_public(host: str, port: int, allowed: Sequence[Network] = ()) -> str:
    """The address to connect to; raises BlockedAddress if any address of `host` is not public."""
    try:
        addrs = [ip_address(host)]
    except ValueError:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
        addrs = [ip_address(info[4][0]) for info in infos]
    if not addrs or any(is_blocked(a, allowed) for a in addrs):
        raise BlockedAddress(host)
    return str(addrs[0])


class WebhookActivities:
    def __init__(
        self,
        pool: asyncpg.Pool,
        *,
        allowed_networks: Sequence[Network] = (),
        encryption_keys: Mapping[str, bytes],
        max_payload_bytes: int = 65_536,
        disable_after_failures: int = 5,
        retention_days: int = 30,
        timeout_seconds: float = 10.0,
    ) -> None:
        self.pool = pool
        self.allowed = allowed_networks
        self.keys = encryption_keys
        self.max_payload_bytes = max_payload_bytes
        self.disable_after = disable_after_failures  # 0 = never auto-disable
        self.retention_days = retention_days  # 0 = keep forever
        # trust_env=False: no proxy from the environment, we connect to the checked address.
        self._http = httpx2.AsyncClient(
            timeout=timeout_seconds, follow_redirects=False, trust_env=False
        )

    async def close(self) -> None:
        await self._http.aclose()

    @activity.defn(name="deliver_webhook")
    async def deliver_webhook(self, d: WebhookDelivery) -> str:
        """One HTTP attempt, recorded in webhook_attempts. Raises to let Temporal retry."""
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", d.orgId)
            row = await conn.fetchrow(
                "select d.status, e.id::text as event_id, e.payload, ep.id::text as endpoint_id,"
                " ep.url, ep.enabled,"
                " ep.secret, ep.previous_secret, ep.previous_secret_expires_at,"
                " (select o.suspended_at is not null from organization o where o.id = ep.org_id)"
                " as org_suspended"
                " from webhook_deliveries d"
                " join webhook_events e on e.id = d.event_id"
                " join webhook_endpoints ep on ep.id = d.endpoint_id"
                " where d.id = $1",
                d.deliveryId,
            )
        if row is None:
            return "gone"  # endpoint (and its deliveries) deleted meanwhile
        if row["status"] == "succeeded" and not d.replay:
            return "succeeded"  # an earlier run of this activity already delivered it

        started = time.monotonic()
        status_code, error = await self._send(row)
        duration_ms = round((time.monotonic() - started) * 1000)
        ok = status_code is not None and 200 <= status_code < 300
        # 410 Gone: the receiver says the endpoint is gone for good (Standard Webhooks).
        final = (
            ok
            or error in PERMANENT
            or status_code == 410
            or activity.info().attempt >= d.maxAttempts
        )
        status = "succeeded" if ok else "failed" if final else "pending"
        if not await self._record(
            d, row["endpoint_id"], status_code, error, duration_ms, status, final
        ):
            return "gone"
        activity.logger.info(
            "webhook delivery %s: %s (status %s, error %s)",
            d.deliveryId,
            status,
            status_code,
            error,
        )
        if not final:
            raise ApplicationError(
                f"webhook delivery failed: {error or status_code}", type="WebhookDeliveryFailed"
            )
        return status

    async def _send(self, row: asyncpg.Record) -> tuple[int | None, str | None]:
        if row["org_suspended"]:
            return None, "org_suspended"
        if not row["enabled"]:
            return None, "endpoint_disabled"
        body: str = row["payload"]
        if len(body.encode()) > self.max_payload_bytes:
            return None, "payload_too_large"
        url: str = row["url"]
        parts = urlsplit(url)
        host = parts.hostname
        if parts.scheme not in ("http", "https") or not host:
            return None, "invalid_url"
        port = parts.port or (443 if parts.scheme == "https" else 80)
        try:
            ip = await resolve_public(host, port, self.allowed)
        except BlockedAddress:
            return None, "blocked_address"
        except OSError:
            return None, "dns_error"

        now = int(time.time())
        stored = [row["secret"]]
        expires: datetime | None = row["previous_secret_expires_at"]
        if row["previous_secret"] and expires and expires > datetime.now(UTC):
            stored.append(row["previous_secret"])
        try:
            secrets = [decrypt_secret(s, row["endpoint_id"], self.keys) for s in stored]
        except Exception:  # unknown key id, wrong key, tampered row: never sign with garbage
            return None, "secret_unreadable"
        msg_id = row["event_id"]
        literal = f"[{ip}]" if ":" in ip else ip
        target = urlunsplit((parts.scheme, f"{literal}:{port}", parts.path or "/", parts.query, ""))
        headers = {
            "host": parts.netloc.rsplit("@", 1)[-1],
            "content-type": "application/json",
            "user-agent": "webhooks/1.0",
            "webhook-id": msg_id,
            "webhook-timestamp": str(now),
            "webhook-signature": " ".join(sign(s, msg_id, now, body) for s in secrets),
        }
        try:
            async with self._http.stream(
                "POST",
                target,
                content=body.encode(),
                headers=headers,
                extensions={"sni_hostname": host},
            ) as res:
                return res.status_code, None  # body deliberately not read
        except httpx2.TimeoutException:
            return None, "timeout"
        except httpx2.TransportError:
            return None, "connection_error"

    async def _record(
        self,
        d: WebhookDelivery,
        endpoint_id: str,
        status_code: int | None,
        error: str | None,
        duration_ms: int,
        status: str,
        final: bool,
    ) -> bool:
        async with self.pool.acquire() as conn, conn.transaction():
            await conn.execute("select set_config('app.org_id', $1, true)", d.orgId)
            # Row lock: concurrent runs (a replay during retries) number attempts in order.
            locked = await conn.fetchval(
                "select id from webhook_deliveries where id = $1 for update", d.deliveryId
            )
            if locked is None:
                return False
            await conn.execute(
                "insert into webhook_attempts"
                " (org_id, delivery_id, attempt, status_code, error, duration_ms)"
                " select $1, $2, coalesce(max(attempt), 0) + 1, $3, $4, $5"
                " from webhook_attempts where delivery_id = $2",
                d.orgId,
                d.deliveryId,
                status_code,
                error,
                duration_ms,
            )
            await conn.execute(
                "update webhook_deliveries set status = $1, updated_at = now() where id = $2",
                status,
                d.deliveryId,
            )
            if final and error not in ("endpoint_disabled", "org_suspended"):
                await self._track_endpoint(conn, d.orgId, endpoint_id, status, status_code)
        return True

    async def _track_endpoint(
        self,
        conn: "PoolConnectionProxy[asyncpg.Record]",
        org_id: str,
        endpoint_id: str,
        status: str,
        status_code: int | None,
    ) -> None:
        """Counts failed deliveries in a row; disables the endpoint on 410 or too many."""
        if status == "succeeded":
            await conn.execute(
                "update webhook_endpoints set consecutive_failures = 0 where id = $1", endpoint_id
            )
            return
        failures: int = await conn.fetchval(
            "update webhook_endpoints set consecutive_failures = consecutive_failures + 1"
            " where id = $1 returning consecutive_failures",
            endpoint_id,
        )
        reason = (
            "gone"
            if status_code == 410
            else "failures"
            if self.disable_after and failures >= self.disable_after
            else None
        )
        if reason is None:
            return
        disabled = await conn.fetchval(
            "update webhook_endpoints set enabled = false, disabled_reason = $1,"
            " disabled_at = now() where id = $2 and enabled returning id",
            reason,
            endpoint_id,
        )
        if disabled is not None:
            await conn.execute(
                "insert into audit_log (org_id, actor_id, action, target)"
                " values ($1, 'worker', 'webhook_endpoint.disabled', $2)",
                org_id,
                endpoint_id,
            )
            activity.logger.warning("disabled webhook endpoint %s (%s)", endpoint_id, reason)

    async def _org_ids(self) -> list[str]:
        # ponytail: one transaction per organization, so RLS applies; fine for thousands of
        # orgs, batch by updated rows if it ever gets slow.
        rows = await self.pool.fetch("select id from organization")
        return [r["id"] for r in rows]

    @activity.defn(name="prune_webhooks")
    async def prune_webhooks(self) -> int:
        """Deletes events (with their deliveries) and attempts older than retention_days."""
        if not self.retention_days:
            return 0
        cutoff = datetime.now(UTC) - timedelta(days=self.retention_days)
        deleted = 0
        for org_id in await self._org_ids():
            async with self.pool.acquire() as conn, conn.transaction():
                await conn.execute("select set_config('app.org_id', $1, true)", org_id)
                for table in ("webhook_attempts", "webhook_events"):
                    result: str = await conn.execute(
                        f"delete from {table} where created_at < $1",  # noqa: S608 - fixed names
                        cutoff,
                    )
                    deleted += int(result.split()[-1])
        activity.logger.info("pruned %d webhook rows older than %s", deleted, cutoff.date())
        return deleted

    @activity.defn(name="reencrypt_webhook_secrets")
    async def reencrypt_webhook_secrets(self) -> int:
        """After a key rotation (new key first in WEBHOOK_ENCRYPTION_KEYS), moves secrets that are
        still under an older key to the active one, so the old key can then be removed. Covers
        the API keys of organization-owned AI providers too (same key ring)."""
        active_id, active_key = next(iter(self.keys.items()))
        prefix = f"v1:{active_id}:"
        moved = 0
        for org_id in await self._org_ids():
            async with self.pool.acquire() as conn, conn.transaction():
                await conn.execute("select set_config('app.org_id', $1, true)", org_id)
                rows = await conn.fetch(
                    "select id::text as id, secret, previous_secret from webhook_endpoints"
                    " where secret not like $1 or previous_secret not like $1 for update",
                    f"{prefix}%",
                )
                for r in rows:
                    try:
                        new = [
                            s
                            if s is None or s.startswith(prefix)
                            else encrypt_secret(
                                decrypt_secret(s, r["id"], self.keys),
                                r["id"],
                                active_id,
                                active_key,
                            )
                            for s in (r["secret"], r["previous_secret"])
                        ]
                    except Exception:  # unreadable row: deliveries already fail visibly for it
                        activity.logger.warning("cannot re-encrypt webhook endpoint %s", r["id"])
                        continue
                    await conn.execute(
                        "update webhook_endpoints set secret = $1, previous_secret = $2"
                        " where id = $3",
                        new[0],
                        new[1],
                        r["id"],
                    )
                    moved += 1
                # AI provider keys: bound to org and row id (apps/api/src/routes/ai-providers.ts).
                for r in await conn.fetch(
                    "select id::text as id, api_key from ai_providers"
                    " where api_key not like $1 for update",
                    f"{prefix}%",
                ):
                    aad = f"{org_id}/{r['id']}"
                    try:
                        plain = decrypt_secret(r["api_key"], aad, self.keys)
                    except Exception:  # unreadable: its calls already fail visibly
                        activity.logger.warning("cannot re-encrypt ai provider %s", r["id"])
                        continue
                    await conn.execute(
                        "update ai_providers set api_key = $1 where id = $2",
                        encrypt_secret(plain, aad, active_id, active_key),
                        r["id"],
                    )
                    moved += 1
        return moved

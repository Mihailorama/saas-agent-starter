"""Minimal S3 client: PUT/GET object and create bucket, signed with AWS SigV4.

Works with AWS S3 and S3-compatible stores (SeaweedFS, MinIO, R2). boto3 is not used because
its dependency tree fails the license gate (docs/adr/0005-license-policy.md).
ponytail: whole objects in memory, no multipart; fine for the small JSON documents we store.
"""

import hashlib
import hmac
from datetime import UTC, datetime
from urllib.parse import quote, urlsplit

import httpx2


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


class S3:
    def __init__(
        self, *, endpoint: str, region: str, access_key: str, secret_key: str, bucket: str
    ) -> None:
        self.endpoint = (endpoint or f"https://s3.{region}.amazonaws.com").rstrip("/")
        self.region, self.bucket = region, bucket
        self._access_key, self._secret_key = access_key, secret_key
        self._http = httpx2.AsyncClient(timeout=30)

    async def close(self) -> None:
        await self._http.aclose()

    async def put(self, key: str, body: bytes, content_type: str = "application/json") -> None:
        res = await self._request("PUT", key, body, {"content-type": content_type})
        res.raise_for_status()

    async def get(self, key: str) -> bytes:
        res = await self._request("GET", key)
        res.raise_for_status()
        return res.content

    async def ensure_bucket(self) -> None:
        if (await self._request("HEAD", "")).status_code == 404:
            res = await self._request("PUT", "")
            if res.status_code != 409:  # created concurrently: fine
                res.raise_for_status()

    async def _request(
        self, method: str, key: str, body: bytes = b"", extra: dict[str, str] | None = None
    ) -> httpx2.Response:
        path = quote(f"/{self.bucket}/{key}" if key else f"/{self.bucket}", safe="/-_.~")
        now = datetime.now(UTC)
        amz_date, day = now.strftime("%Y%m%dT%H%M%SZ"), now.strftime("%Y%m%d")
        payload_hash = hashlib.sha256(body).hexdigest()
        signed = {
            "host": urlsplit(self.endpoint).netloc,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": amz_date,
        }
        names = ";".join(signed)
        canonical = "\n".join(
            [method, path, "", *(f"{k}:{v}" for k, v in signed.items()), "", names, payload_hash]
        )
        scope = f"{day}/{self.region}/s3/aws4_request"
        to_sign = "\n".join(
            ["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode()).hexdigest()]
        )
        key_bytes = f"AWS4{self._secret_key}".encode()
        for part in (day, self.region, "s3", "aws4_request"):
            key_bytes = _hmac(key_bytes, part)
        signature = hmac.new(key_bytes, to_sign.encode(), hashlib.sha256).hexdigest()
        headers = {
            **signed,
            **(extra or {}),
            "authorization": f"AWS4-HMAC-SHA256 Credential={self._access_key}/{scope}, "
            f"SignedHeaders={names}, Signature={signature}",
        }
        return await self._http.request(method, self.endpoint + path, content=body, headers=headers)

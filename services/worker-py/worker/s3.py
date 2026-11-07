"""S3 client for the worker's objects (AI content, privacy exports): the official MinIO SDK.

It speaks the plain S3 API, so it works with AWS S3, R2, SeaweedFS and MinIO. boto3 is not used
because its dependency tree fails the license gate (docs/adr/0005-license-policy.md). The SDK is
synchronous: each call runs in a thread so the event loop stays free.
"""

import asyncio
import io
from urllib.parse import urlsplit

import urllib3
from minio import Minio
from minio.error import S3Error


class NotFound(KeyError):
    """No object under that key (S3 `NoSuchKey`)."""


class S3:
    def __init__(
        self, *, endpoint: str, region: str, access_key: str, secret_key: str, bucket: str
    ) -> None:
        url = urlsplit(endpoint or f"https://s3.{region}.amazonaws.com")
        self.bucket = bucket
        self._http = urllib3.PoolManager(timeout=30)  # urllib3 comes with minio
        self._client = Minio(
            url.netloc,
            access_key=access_key,
            secret_key=secret_key,
            region=region,
            secure=url.scheme == "https",
            http_client=self._http,
        )

    async def close(self) -> None:
        self._http.clear()

    async def put(self, key: str, body: bytes, content_type: str = "application/json") -> None:
        await asyncio.to_thread(
            self._client.put_object,
            self.bucket,
            key,
            io.BytesIO(body),
            len(body),
            content_type=content_type,
        )

    async def get(self, key: str) -> bytes:
        def read() -> bytes:
            try:
                res = self._client.get_object(self.bucket, key)
            except S3Error as e:
                if e.code == "NoSuchKey":
                    raise NotFound(key) from e
                raise
            try:
                return res.read()
            finally:
                res.close()
                res.release_conn()

        return await asyncio.to_thread(read)

    async def delete(self, key: str) -> None:
        """Idempotent: deleting a missing key succeeds (S3 answers 204 either way)."""
        await asyncio.to_thread(self._client.remove_object, self.bucket, key)

    async def list_keys(self, prefix: str) -> list[str]:
        """Every key under `prefix` (ListObjectsV2, all pages)."""

        def keys() -> list[str]:
            found = self._client.list_objects(self.bucket, prefix=prefix, recursive=True)
            return [o.object_name for o in found if o.object_name]

        return await asyncio.to_thread(keys)

    async def ensure_bucket(self) -> None:
        def ensure() -> None:
            if self._client.bucket_exists(self.bucket):
                return
            try:
                self._client.make_bucket(self.bucket)
            except S3Error as e:  # created concurrently: fine
                if e.code not in ("BucketAlreadyOwnedByYou", "BucketAlreadyExists"):
                    raise

        await asyncio.to_thread(ensure)

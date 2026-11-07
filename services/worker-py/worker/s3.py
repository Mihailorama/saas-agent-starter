"""S3 client for the AI request/response content: the official MinIO SDK (Apache-2.0).

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
            res = self._client.get_object(self.bucket, key)
            try:
                return res.read()
            finally:
                res.close()
                res.release_conn()

        return await asyncio.to_thread(read)

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

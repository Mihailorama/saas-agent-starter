import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env.ts';

const client = (endpoint?: string) =>
  new S3Client({
    region: env.S3_REGION,
    endpoint,
    forcePathStyle: Boolean(endpoint), // S3-compatible servers (SeaweedFS, MinIO, R2...)
    // Presigned browser uploads cannot know the SDK's default CRC checksum up front.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });

const s3 = client(env.S3_ENDPOINT);
// Presigned URLs embed the host, so sign them for the endpoint browsers can reach.
const signer = client(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT);

export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    // Concurrent callers (test files, replicas) may create it first: that is success too.
    await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET })).catch((err) => {
      if ((err as { name?: string }).name !== 'BucketAlreadyOwnedByYou') throw err;
    });
  }
}

/** LLM request/response JSON written by the worker; null when gone (retention expired). */
export const getAiContent = (key: string) => getJson(env.AI_CONTENT_BUCKET, key);

/** A JSON object, or null when it is gone. */
export async function getJson(bucket: string, key: string): Promise<unknown> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse((await res.Body?.transformToString()) ?? 'null');
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return null;
    throw err;
  }
}

/** A JSON object in the uploads bucket, e.g. a tracker item for the worker (routes/hooks.ts). */
export async function putJson(key: string, value: unknown) {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
    }),
  );
}

const EXPIRES = 300;

export const presignUpload = (key: string, contentType: string, size: number) =>
  getSignedUrl(
    signer,
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ContentType: contentType,
      ContentLength: size,
    }),
    { expiresIn: EXPIRES },
  );

export const presignDownload = (key: string, filename: string) =>
  getSignedUrl(
    signer,
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${encodeURIComponent(filename)}"`,
    }),
    { expiresIn: EXPIRES },
  );

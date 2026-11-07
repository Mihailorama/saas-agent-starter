import createClient, { type Middleware } from 'openapi-fetch';
import { track } from '@/lib/analytics';
import type { paths } from '@/lib/api.gen';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
/** The 200 JSON body of an API operation, from the generated types (`pnpm api:types`). */
export type Ok<P extends keyof paths, M extends Method> = paths[P][M] extends {
  responses: { 200: { content: { 'application/json': infer T } } };
}
  ? T
  : never;
/** The JSON request body of an API operation. */
export type Body<P extends keyof paths, M extends Method> = paths[P][M] extends {
  requestBody?: { content: { 'application/json': infer T } };
}
  ? T
  : never;
export type Project = Ok<'/api/projects/{id}', 'get'>;
export type AiStatus = NonNullable<Project['aiStatus']>;
export type AiCall = Ok<'/api/orgs/{orgId}/ai-calls/', 'get'>['items'][number];
export type Attachment = Ok<'/api/projects/{id}/attachments', 'get'>[number];

let lastTrace: string | null = null;
/** Trace id of the latest API response (`x-trace-id`), attached to support requests. */
export const lastTraceId = () => lastTrace;

const failed = (method: string, schemaPath: string, status: number, traceId: string | null) =>
  track('api_error', {
    method,
    path: schemaPath.replace(/\{\w+\}/g, ':id'),
    status,
    trace_id: traceId ?? '',
  });
const errors: Middleware = {
  onResponse({ request, response, schemaPath }) {
    lastTrace = response.headers.get('x-trace-id') ?? lastTrace;
    if (!response.ok) {
      failed(request.method, schemaPath, response.status, response.headers.get('x-trace-id'));
    }
  },
  onError({ request, schemaPath }) {
    failed(request.method, schemaPath, 0, null);
  },
};

/** Typed client for our API: paths, params and bodies come from its OpenAPI document. */
export const client = createClient<paths>({ credentials: 'include' });
client.use(errors);

/** The data of a client call; throws with the server's error message on non-2xx. */
export async function ok<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (!response.ok) {
    const body = (error ?? {}) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `Request failed (${response.status})`);
  }
  return data as T;
}

/**
 * JSON call to an endpoint hidden from the OpenAPI document (operator console, `schema.hide`),
 * which therefore has no generated types. Everything else goes through `client`.
 */
export async function api<T>(path: string, init?: { method?: string; json?: unknown }): Promise<T> {
  const method = init?.method ?? 'GET';
  const route = path.split('?')[0]!.replace(/[0-9a-f-]{36}/gi, '{id}');
  const res = await fetch(path, {
    method,
    credentials: 'include',
    ...(init?.json !== undefined && {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(init.json),
    }),
  }).catch((err) => {
    failed(method, route, 0, null);
    throw err;
  });
  lastTrace = res.headers.get('x-trace-id') ?? lastTrace;
  if (!res.ok) {
    failed(method, route, res.status, res.headers.get('x-trace-id'));
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export const formatBytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

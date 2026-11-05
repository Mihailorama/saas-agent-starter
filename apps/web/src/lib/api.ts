export type AiStatus = 'generated' | 'confirmed' | 'corrected';
export type Project = {
  id: string;
  name: string;
  description: string | null;
  fingerprint: string | null;
  aiSummary: string | null;
  aiStatus: AiStatus | null;
  aiCallId: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
};
export type AiCall = {
  id: string;
  actorId: string | null;
  purpose: string;
  provider: string;
  requestModel: string;
  responseModel: string | null;
  promptTemplateId: string;
  promptTemplateVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cost: number | null;
  costCurrency: string | null;
  latencyMs: number;
  status: 'ok' | 'error';
  errorClass: string | null;
  traceId: string | null;
  contour: string;
  createdAt: string;
};
export type Attachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
};

/** JSON fetch against our API. Throws with the server's error message on non-2xx. */
export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: init?.json === undefined ? init?.headers : { 'content-type': 'application/json' },
    body: init?.json === undefined ? init?.body : JSON.stringify(init.json),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
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

// The registry's HTTP API (OCI distribution spec), for scripts/deploy.mjs and scripts/infra.mjs:
// digests to pin a release by, and the newest release tag. No Docker needed on this machine.
// Plain HTTP only for loopback or REGISTRY_INSECURE=1 (a local test registry), then never
// credentials; a private registry takes REGISTRY_AUTH=user:token.

/** GET or HEAD `/v2/<name>/<path>` of `repo` (registry host first), anonymous token flow. */
async function registryFetch(repo, path, method = 'GET', accept = 'application/json') {
  const env = process.env;
  const [host, ...rest] = repo.split('/');
  const name = rest.join('/');
  if (!(host.includes('.') || /^localhost(:\d+)?$/.test(host)) || !name) {
    throw new Error(`IMAGE_REPO ${repo}: must start with a registry host (ghcr.io/owner/name)`);
  }
  const http = /^(localhost|127\.)/.test(host) || env.REGISTRY_INSECURE === '1';
  const url = `${http ? 'http' : 'https'}://${host}/v2/${name}/${path}`;
  let res = await fetch(url, { method, headers: { accept } });
  if (res.status === 401) {
    // Bearer token flow: realm/service/scope from WWW-Authenticate, anonymous unless REGISTRY_AUTH.
    const p = Object.fromEntries(
      [...(res.headers.get('www-authenticate') ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const tokenUrl = new URL(p.realm);
    if (tokenUrl.protocol !== 'https:' && !http)
      throw new Error(`${host}: token realm is not https`);
    if (p.service) tokenUrl.searchParams.set('service', p.service);
    tokenUrl.searchParams.set('scope', p.scope ?? `repository:${name}:pull`);
    const auth =
      env.REGISTRY_AUTH && !http
        ? { authorization: `Basic ${Buffer.from(env.REGISTRY_AUTH).toString('base64')}` }
        : {};
    const t = await fetch(tokenUrl, { headers: auth });
    const body = t.ok ? await t.json() : {};
    const token = body.token ?? body.access_token;
    if (token) {
      res = await fetch(url, { method, headers: { accept, authorization: `Bearer ${token}` } });
    }
  }
  return res;
}

/** `repo@sha256:...` of repo:tag. */
export async function registryDigest(repo, tag) {
  const accept = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
  ].join(', ');
  const res = await registryFetch(repo, `manifests/${tag}`, 'HEAD', accept);
  const digest = res.headers.get('docker-content-digest');
  if (!res.ok || !/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) {
    throw new Error(
      `${repo}:${tag} not found in the registry (HTTP ${res.status}). Released yet? Private? Set REGISTRY_AUTH=user:token`,
    );
  }
  return `${repo}@${digest}`;
}

/** The highest `vX.Y.Z` among tags (pre-releases and other tags ignored), or undefined. */
export function newestRelease(tags) {
  const v = (t) => t.slice(1).split('.').map(Number);
  return tags
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort((a, b) => {
      const [x, y] = [v(a), v(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    })
    .at(-1);
}

/** The newest release of the app images in `repo` (tags of its api image). */
export async function latestRelease(repo) {
  const res = await registryFetch(`${repo}/api`, 'tags/list?n=1000');
  const tags = res.ok ? ((await res.json()).tags ?? []) : [];
  const tag = newestRelease(tags);
  if (!tag)
    throw new Error(
      `${repo}: no release (v*) found (HTTP ${res.status}): not published yet, or private (REGISTRY_AUTH=user:token)`,
    );
  return tag;
}

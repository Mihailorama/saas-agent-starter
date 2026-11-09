# Security

## Reporting

Please report vulnerabilities privately through GitHub Security Advisories
("Report a vulnerability" on the repository's Security tab). Do not open public issues for
security problems. We aim to acknowledge reports within a few days.

## Defaults this starter ships with

- Tenant isolation by Postgres Row-Level Security; the API connects as a role that cannot
  bypass RLS and refuses to start otherwise.
- Sessions in HttpOnly, SameSite=Lax cookies (Secure in production), Origin checks on
  unsafe requests, CORS allowlist from env.
- Helmet security headers (CSP, HSTS) on the API; CSP and HSTS on the web container.
- Rate limits on sign-in/sign-up (Redis-backed, shared across replicas).
- Zod validation of env and every request/response; generic error bodies.
- Structured logs with redaction; query strings and headers are never logged.
- Audit log row for every mutating tenant request, in the same transaction.
- CI: gitleaks, osv-scanner, CodeQL, Dependabot, license allowlist gate.

## Operator notes

- Set `TRUST_PROXY` only behind reverse proxies you control, preferably to their number of hops
  (`compose.prod.yaml`: `2`) rather than `true`; otherwise clients could spoof `X-Forwarded-For`
  and evade per-IP rate limits or pollute audit IPs.
- The compose file contains example credentials for local development only.

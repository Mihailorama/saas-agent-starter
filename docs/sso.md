# Staff single sign-on into the tools

The app is the OpenID Connect provider for the web UIs of the tools around it (Grafana,
Vaultwarden, Temporal UI, Langfuse, ...). An operator signs in to the app once (email code, then
two-factor) and opens every tool without a separate account or password there. Customers never
see this: it is for the team that runs the product. Tracker: SAASSTARTER-97.

This is the opposite direction of `OIDC_*` in `.env.example`, where the app signs its users in
with _your_ IdP. Both can be on at once.

## Who gets in

Only an operator (docs/admin.md: listed in `OPERATOR_EMAILS`, verified address) with two-factor
on, the same bar as the operator console. Anyone else can finish the app's sign-in, but the token
request for a tool is refused (403, `apps/api/src/sso.ts`), so the tool never lets them in. A tool
gets `groups: ["operators"]` in the ID token and from UserInfo for its role mapping.

Remove someone from `OPERATOR_EMAILS` (and restart the API) and they get no new tokens. Sessions a
tool already created live on until that tool expires them; sign them out there if it matters.

## How it works

- `@better-auth/oauth-provider` (MIT, the same Better Auth line as the app's auth) serves
  discovery at `${BETTER_AUTH_URL}/api/auth/.well-known/openid-configuration`; the issuer is
  `${BETTER_AUTH_URL}/api/auth`. ID tokens are signed RS256 with keys from the `jwt` plugin
  (`/api/auth/jwks`, private keys encrypted in the `jwks` table).
- Clients come only from the environment: `SSO_<TOOL>_SECRET` (32+ random characters in
  production) and `SSO_<TOOL>_REDIRECT_URIS` (comma-separated). The API writes them at start and
  disables the ones whose variables are gone. Tool ids: `grafana`, `temporal-ui`, `langfuse`,
  `vaultwarden`, `glitchtip`, `postiz`, `oauth2-proxy` (`SSO_TEMPORAL_UI_SECRET` for
  `temporal-ui`). The provider's client and consent management endpoints are closed (404), as is
  dynamic registration.
- No consent screen (the tools are first-party). A signed-out visitor is sent to `/sign-in`; after
  the code and two-factor steps the web resumes the tool's request (`oauthResume` in
  `apps/web/src/pages/sign-in.tsx`).
- Each tool reaches the app twice: the browser at `BETTER_AUTH_URL`, and the tool's server at the
  token and UserInfo endpoints. In production both are the public `https://` domain. In local dev
  the tool's container cannot use `localhost`, so its server-side calls go to
  `SSO_BACKCHANNEL_URL` (default `http://host.docker.internal:3000`, the API on the host). A host
  firewall that blocks containers from host ports breaks that leg (the callback hangs).

## Tools

What each tool's free edition offers was checked against its source or docs on 2026-11-13.

| Tool                                              | How                                                      | Settings                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grafana                                           | Native generic OAuth, Admin from `groups`                | `docker-compose.yml` (`GRAFANA_SSO=true`); covered by `e2e/sso.spec.ts`                                                                                                                                                                                                                           |
| Vaultwarden                                       | Native OIDC                                              | `compose.prod.yaml` `vault` (on when `SSO_VAULTWARDEN_SECRET` is set); the master password still unlocks the vault                                                                                                                                                                                |
| Temporal UI                                       | Native OIDC                                              | `TEMPORAL_AUTH_ENABLED=true`, `TEMPORAL_AUTH_TYPE=oidc`, `TEMPORAL_AUTH_PROVIDER_URL` and `TEMPORAL_AUTH_ISSUER_URL` = the issuer, `TEMPORAL_AUTH_CLIENT_ID=temporal-ui`, `TEMPORAL_AUTH_CLIENT_SECRET`, `TEMPORAL_AUTH_CALLBACK_URL=<ui>/auth/sso/callback`, scopes `openid`, `email`, `profile` |
| Langfuse                                          | Native custom OIDC                                       | `AUTH_CUSTOM_CLIENT_ID=langfuse`, `AUTH_CUSTOM_CLIENT_SECRET`, `AUTH_CUSTOM_ISSUER` = the issuer, `AUTH_CUSTOM_NAME`; callback `<langfuse>/api/auth/callback/custom`; `AUTH_DISABLE_USERNAME_PASSWORD=true` once it works                                                                         |
| GlitchTip                                         | OpenID Connect through django-allauth                    | Django admin, Social applications: provider "OpenID Connect", client `glitchtip`, settings `{"server_url": "<issuer>/.well-known/openid-configuration"}`                                                                                                                                          |
| Postiz                                            | Generic OAuth (UserInfo)                                 | `POSTIZ_GENERIC_OAUTH=true`, `POSTIZ_OAUTH_AUTH_URL`, `POSTIZ_OAUTH_TOKEN_URL`, `POSTIZ_OAUTH_USERINFO_URL`, `POSTIZ_OAUTH_CLIENT_ID=postiz`, `POSTIZ_OAUTH_CLIENT_SECRET`; callback `<postiz>/settings`                                                                                          |
| Prometheus, Jaeger, Mailpit, SeaweedFS, Promptfoo | No login of their own: put oauth2-proxy in front (below) | client `oauth2-proxy`                                                                                                                                                                                                                                                                             |
| Twenty, Chatwoot CE, Plane CE, Cal.diy            | SSO is a paid edition or removed                         | own login stays; oauth2-proxy can only add a gate in front                                                                                                                                                                                                                                        |
| Umami, SerpBear                                   | No OIDC at all                                           | as above                                                                                                                                                                                                                                                                                          |

Only Grafana runs end to end in CI. The other native rows follow each tool's own documentation;
when you switch one on, sign in once by hand and keep its local login until that works.

## A tool without a login: oauth2-proxy behind Caddy

oauth2-proxy (MIT) as one extra container, `forward_auth` in Caddy for each tool's site:

```
oauth2-proxy --provider=oidc --oidc-issuer-url=https://app.example.com/api/auth \
  --client-id=oauth2-proxy --client-secret=$SSO_OAUTH2_PROXY_SECRET \
  --redirect-url=https://tools.example.com/oauth2/callback --email-domain='*' \
  --allowed-group=operators --oidc-groups-claim=groups --scope='openid email profile groups' \
  --cookie-secret=<32 random bytes> --cookie-domain=.example.com --reverse-proxy --set-xauthrequest
```

```
prometheus.example.com {
	handle /oauth2/* {
		reverse_proxy oauth2-proxy:4180
	}
	handle {
		forward_auth oauth2-proxy:4180 {
			uri /oauth2/auth
			copy_headers X-Auth-Request-User X-Auth-Request-Email
			@unauth status 401
			handle_response @unauth {
				redir * /oauth2/sign_in?rd={scheme}://{host}{uri}
			}
		}
		reverse_proxy prometheus:9090
	}
}
```

Register `SSO_OAUTH2_PROXY_REDIRECT_URIS` with every callback host you use.

## Test it

- API: `apps/api/test/sso.test.ts` runs the authorization code flow as a tool does (discovery,
  RS256 signature from JWKS, UserInfo, refusals, closed endpoints).
- Browser: `e2e/sso.spec.ts` starts signed out at Grafana and ends there as Admin. It runs when
  `E2E_GRAFANA_URL` is set and Grafana was started with the same secret:

```sh
GRAFANA_SSO=true GRAFANA_ANONYMOUS=false SSO_GRAFANA_SECRET=local-dev-grafana-sso-secret \
  docker compose --profile observability up -d --no-deps --wait grafana
E2E_GRAFANA_URL=http://localhost:3001 pnpm e2e
```

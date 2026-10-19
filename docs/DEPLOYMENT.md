# Hosting and Fo integration preparation

**Code verified with synthetic credentials/devices; not live deployment-ready or Fo-connected.** No host, credentials, account clients, persistent access or registration were created. The earlier mandatory external-OAuth assumption was unjustified and has been corrected. The bounded hackathon path uses Fo's explicitly advertised static-bearer connection mode, with an independent protected owner interface. OAuth remains an optional advanced profile.

For the offline digest-only helper, exact configuration approval, approval-only Fo execution and native-pairing boundaries, follow [user-controlled credential handoff](CREDENTIAL-HANDOFF.md).

## Minimal single-owner bearer configuration

Use [remote.env.example](../deploy/remote.env.example). No file loads automatically. Supply approved values through the host environment; never commit a populated file.

| Field                                                                | Required value                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `FO_FIX_MODE`                                                        | `remote` (also forced by `--remote`)                                               |
| `FO_FIX_AUTH_MODE`                                                   | `bearer`                                                                           |
| `FO_FIX_PUBLIC_ORIGIN`                                               | Exact approved HTTPS origin, no path/query/fragment/userinfo                       |
| `FO_FIX_BACKEND`                                                     | `fixture` first; all repairs remain synthetic                                      |
| `FO_FIX_MCP_TOKEN_SHA256`                                            | SHA-256 lowercase hex digest of a unique MCP credential                            |
| `FO_FIX_OWNER_TOKEN_SHA256`                                          | Digest of a separate owner credential; must differ                                 |
| `FO_FIX_ACCESS_EXPIRES_AT`                                           | Absolute UTC ISO timestamp in the next 24 hours; no automatic renewal              |
| `FO_FIX_LISTEN_HOST`, `FO_FIX_TRUST_PROXY`, `FO_FIX_PROXY_ADDRESSES` | Explicit hosting boundary described below                                          |
| `FO_FIX_DATA`                                                        | Optional absolute private persistent SQLite path; default `.fo-fix/fixture.sqlite` |

Each credential must be independently authorized, unique to this deployment, contain at least 32 random bytes and be base64url encoded (43–128 characters). The server validates that shape and compares only SHA-256 digests in constant time; it cannot prove entropy. **Do not use memorable passwords, reuse credentials, or copy the synthetic test constants.** This implementation creates no real credentials. Creating/provisioning them is a separate authorized operator step; no generation command runs during build/startup/tests.

The MCP plaintext goes only to Fo's credential form. The owner plaintext goes only to the owner, entered into the masked form at the approved HTTPS origin. It never goes to Fo, an MCP tool argument, a URL, command argument, browser storage or logs. Only its digest is configured on the server. Owner login creates an opaque Secure/HttpOnly/SameSite=Strict host-only cookie, expires within 15 minutes and the deployment deadline, and uses same-origin plus synchronizer CSRF checks for mutations. The input is cleared after submission. Login is limited to ten attempts per minute per process; session storage is bounded. Bearer headers, including owner headers, never authenticate `/api/*` or owner approval routes.

`/mcp` accepts only the independently configured MCP bearer. It cannot sign in as owner, grant device inspection or approve. Owner and companion credentials cannot authenticate MCP. Query credentials are ignored. The access deadline is checked on each authenticated request; restarting clears owner sessions. Credential rotation/revocation requires approved configuration change and restart. Extending access is not automatic.

This is an explicitly configured single-owner bearer profile supported by Fo, not OAuth discovery or an authorization-server implementation. A 401 includes a plain Bearer challenge; the OAuth resource-metadata path returns 404 in this mode. It is not advertised as implementing the MCP OAuth authorization flow for every client. The [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) describes the broader OAuth discovery flow; use the optional profile only with verified compatible infrastructure.

## Hosting boundary and runtime

The selected GCP variant is documented in [GCP-VM.md](GCP-VM.md), with local Caddy, a single supervised process and explicit persistent-disk startup guards. Its read-only preflight is separate from approval-gated resource, network, credential and service activation steps.

Use **Node 24.19.0**, the tested version and Docker pin. Build with `npm ci && npm run build`; runtime can use `npm ci --omit=dev`. The same Node process serves UI/API/MCP. Start it directly under the host's supervisor:

```bash
node --use-env-proxy --import tsx src/server/main.ts --remote
```

No API key, model service, frontend development server, worker or Redis is required. `FO_FIX_PORT` overrides host `PORT`, otherwise 4310; use a port >=1024. The public origin must be HTTPS.

Choose one explicit proxy arrangement:

- **Conventional private upstream:** set `FO_FIX_LISTEN_HOST=0.0.0.0`, `FO_FIX_TRUST_PROXY=addresses` and `FO_FIX_PROXY_ADDRESSES` to at most 16 verified exact source IPs of the approved TLS proxy. No CIDR, hop count, wildcard, hostname or unspecified address is accepted. The socket peer, not a caller-supplied forwarded address, is checked. Restrict upstream network access to the proxy too. [host.env.example](../deploy/host.env.example) records this contract.
- **Same-host/namespace TLS proxy:** retain `FO_FIX_LISTEN_HOST=127.0.0.1`, `FO_FIX_TRUST_PROXY=loopback`, and omit `FO_FIX_PROXY_ADDRESSES`. Use [nginx.conf.example](../deploy/nginx.conf.example). Its TLS certificate and hostname must be existing approved resources. A container needs the proxy in the same network namespace in this profile.

In both cases the proxy must preserve the incoming `Host` for exact configured-origin validation and overwrite `X-Forwarded-Proto` with exactly `https`, preserve Authorization/cookies, disable buffering, and allow at least 40-second request/response timeouts. Foreign Host/Origin and cross-site owner mutations still fail. Do not log Authorization, cookies, bodies, OAuth query strings or credentials. Health checks must traverse the same trusted proxy with these Host/HTTPS headers, or use a TCP probe; a direct unauthenticated HTTP probe is rejected. No broad Express proxy trust is enabled. If a platform cannot provide a trusted bounded peer set or a suitable same-host TLS arrangement, compatibility has not been established; do not weaken these checks or buy hosting on an assumption.

The [Dockerfile](../Dockerfile) supports these runtime-selected profiles but has not been image-built or deployed. One long-running process/replica is supported. Owner sessions and gateway queues are in memory; fixture SQLite uses lifetime exclusive locking and a private writable persistent directory, including its rollback journal. No autoscaling, independent replicas, scale-to-zero, ephemeral fixture-history persistence or transactional multi-instance claims are made. Allow graceful SIGTERM shutdown before replacing the process.

MCP is stateless Streamable HTTP POST with JSON responses; GET returns 405. There are no WebSockets or persistent SSE streams. Companion polling holds an outbound request at most ten seconds; relayed tools wait at most 25 seconds. No CPU/RAM/throughput sizing or actual provider routing has been measured.

## Exact Fo registration and credential handoff

The parent session independently read the current official `https://mcp.wajo.ai/mcp` tools/list catalogue. It confirmed the following schema; this cloud's direct retrieval remains proxy-denied. This is advertised capability, **not a live registration or invocation result**.

A reviewable registration request is:

```json
{
  "serverName": "Fo Reach",
  "url": "https://<approved-host>/mcp",
  "transport": "streamable_http",
  "auth": "bearer",
  "scope": "personal"
}
```

`build_mcp_server` requires `serverName` and `url`. Set the three explicit options shown; scope otherwise defaults to organization. Optional `secretName` chooses the per-user credential-store key; its default derives from the server name. The credential bag is **`{token}`**, supplied by the user through Fo/Wajo's credential form **after registration**. The plaintext token is never a `build_mcp_server` argument. `oauthProviderId` is irrelevant for bearer mode. No actual call is authorized or made here.

After explicit registration authorization, use the approved name/origin and let the user enter only the MCP credential in that form. Keep the owner credential private and separate. The existing Fo connector in ChatGPT is not this custom connection. The observed manual path is [Connections](https://wajo.ai/user/connections?status=all) → Add MCP → Enter manually.

Live acceptance must first use synthetic fixture state: inspect after owner consent, propose, reject unapproved execution, approve through the separate owner UI, execute, verify source/history, propose undo, require new approval and verify restoration. Only a live Fo invocation establishes compatibility. Credential-form behavior, actual HTTPS hosting, tool results and token lifecycle still need that authorized acceptance pass.

## Separate device session

`FO_FIX_BACKEND=session` additionally requires a fixed `FO_FIX_DEVICE_ID` (at most 128 characters) and a third distinct `FO_FIX_COMPANION_TOKEN_SHA256`. The Mac runs its loopback companion, then a separate foreground `npm run companion:connect` with approved gateway origin/device ID and the companion plaintext in `FO_FIX_COMPANION_ACCESS_TOKEN`. No credential is obtained/generated automatically. Preserve approved proxy settings and bypass loopback with `NO_PROXY` where needed.

The bridge uses outbound HTTPS only, lasts at most 20 minutes or the access deadline, and never reconnects automatically. Machine requests use strict tool schemas with no permission grant, approval, terminal or arbitrary URL operation. The engine, SQLite journal, file lease, native verification and separately approved undo stay on the device. Optional [bounded owner phone review](PHONE-REVIEW.md) uses a separate owner-only request envelope, enabled only through explicit local opt-in for one exact session and existing file lease. It supports review approval and bounded fixed previews; it cannot grant/renew file permission or approve audio/app changes. An offline device is unavailable, not a fabricated fixture. Ending the gateway session blocks new requests but cannot cancel an already-started write. Normal phone-enabled bridge cleanup revokes review access; forced termination relies on the fixed session/lease deadlines. Lost delivered changes are uncertain and never retried; inspect the local journal. A still-valid configured bearer remains usable until its deadline or server-side revocation.

The native CoreAudio helper still needs macOS compilation/hardware verification. The cloud can continue fixture development while the Mac is offline; it cannot repair an offline Mac.

## Optional OAuth profile

[oauth.env.example](../deploy/oauth.env.example) preserves the previous external-provider profile behind explicit `FO_FIX_AUTH_MODE=oauth`. Its issuer/JWKS/endpoints, pinned subject, exact audience, isolated scopes and distinct client IDs are implementation-specific and require a compatible provider. Owner public PKCE, callback `<origin>/owner/auth/callback`, and RFC 9068 `at+jwt` RS256/ES256 access tokens with `client_id`, `scope`, `jti`, `iat`, `exp` remain required. Audiences are `<origin>/mcp`, `/owner`, `/session`; scopes are `fofix:mcp`, `fofix:owner`, `fofix:companion`; maximum token life is one hour. All issuer endpoints must share the configured HTTPS origin.

The current Fo catalogue says OAuth requires an operator-curated **`oauthProviderId`**, or Dynamic Client Registration when that field is empty. An issuer URL alone is insufficient. Fo Fix implements neither DCR nor an authorization server, and no compatible curated provider is available/verified here. Therefore OAuth is **not the prerequisite or recommended hackathon path**; do not provision an identity platform for this MVP without a separate reason and authorization.

## Safe diagnostics

`npm run diagnostics` and authenticated `GET /api/diagnostics` return only field names, fixed issue messages and presence flags, never credentials/digests/proxy values. No network/model call runs automatically. `npm run diagnostics:network` optionally performs two fixed unauthenticated HEAD probes. This cloud reports missing `ANTHROPIC_API_KEY` and proxy denial for Anthropic/Wajo; those are separate from the bearer repair runtime. The opt-in Haiku smoke test remains excluded from checks/startup. No paid request has been made.

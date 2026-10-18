# Verification evidence — 2026-10-18

This report concerns the code built in `/workspace/wajo-hack` in a Linux cloud environment. **All successful repairs used synthetic fixtures. No actual personal-device repair, real Mac test, or live Fo registration has been demonstrated.**

The latest [Fo execution and credential handoff review](FO-FLOW-REVIEW.md) records approval-only execution, owner deadlines, offline helper checks, independent reviews and known browser/hardware limitations.

## Passing checks

The final `npm run check` runs the production TypeScript/bundle build, 70 engine/API/MCP/authentication/session/configuration/proxy/lifecycle/native-contract/response-limit/helper tests, and 16 real Chromium browser tests. Its complete output is retained in [check-output.txt](check-output.txt).

| Check                       | Result and scope                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`             | Passed: TypeScript strict check and Vite production bundle                                                                                                            |
| `npm test`                  | 70 passed, zero failed/skipped: local repair/persistence, HTTP/stdio MCP, lifecycle, remote authentication, configuration and device sessions                         |
| `npm run test:e2e`          | 16 passed, zero failed: repair flow, responsive layout, automated accessibility, keyboard behavior, browser/MCP interoperability, owner login and companion authority |
| MCP HTTP                    | Official SDK client initialized the server, listed five strict tools, called tools, and verified approval enforcement and shared history                              |
| MCP stdio                   | Official SDK client started the stdio bridge, listed tools, and read the same running companion's history and permission state                                        |
| Native build platform guard | Correctly refused macOS compilation on Linux; this is a limitation, not a native-build success                                                                        |

Environment: Node.js 24.19.0, npm 11.9.0, Python 3.12.14, Linux, system Chromium 154.0.8037.57. The project pins MCP SDK 1.32.1, Playwright 1.64.1, React 19.3.1, Vite 8.3.4, TypeScript 5.9.3 and runtime loader tsx 4.23.15, and JWT verifier jose 6.2.12; esbuild resolves to 0.28.2. Playwright ran using the existing `/usr/bin/chromium`; there was no browser install or system configuration change.

The version 4 baseline was reproduced (56 unit/API and seven browser tests) before the latest review. The [Fo Reach version 4 review](REVIEW-2026-10-18.md) records the new findings, fixes, failures and 79 final passing checks. The preserved baseline was reproduced before review. Follow-up changes and their regression coverage are recorded in [the security review](SECURITY-REVIEW.md). The final production dependency audit is retained in [production-audit.json](production-audit.json); it does not cover every possible security defect. Classifying the loader correctly as a runtime dependency exposed one low-severity esbuild advisory, which was resolved by updating the loader and esbuild before the final checks. The final audit reports zero known production vulnerabilities.

### Integration compatibility correction

The earlier mandatory OAuth provider contract was not justified by actual Fo registration evidence. The parent's current official catalogue read confirmed bearer mode and a secure post-registration `{token}` credential form; OAuth requires curated `oauthProviderId` or DCR. Code now provides an explicit expiring single-owner bearer profile without issuer/client/scope requirements, preserves optional OAuth, and supports conventional host `PORT`/private listener with an exact proxy-IP allowlist. This is tested integration preparation, **not a live deployment-ready claim**.

The final pass added five bearer/configuration/proxy tests, ran the full separate-device routing/unmute/undo flow under bearer as well as OAuth, and added a seventh browser test for masked independent owner login and no credential in browser storage. All 56 unit/API and seven browser tests passed on the first full compatibility-correction run. No dependency versions changed; the retained zero-vulnerability production audit remains applicable. The existing isolated production-only install was refreshed with the new source/bundle and verified with a synthetic remote bearer profile, host `PORT`, `0.0.0.0` listener, configured trusted proxy peer, owner/MCP separation and clean SIGTERM. It required no OAuth configuration. See [production-install-check.json](production-install-check.json).

### Deployment preparation checks

- In the optional OAuth profile, signed synthetic access tokens are verified cryptographically with jose. Tests reject wrong issuer, signature, expiry, token type, subject, audience (including arrays), client and scope. MCP cannot use owner/companion tokens or approve through owner APIs. Discovery stays public; missing auth fails closed.
- Optional OAuth owner authorization-code/PKCE flow tests check cookie-bound single-use state, code verifier binding, owner-only access-token exchange, Secure/HttpOnly/SameSite cookies, CSRF, logout and session expiry. JWKS fetch tests cover pinned destinations, bounded responses and redirect refusal. Provider responses are injected test fixtures; no real account, OAuth client, signing credential or identity provider was created.
- Real HTTP gateway and separate companion servers perform route and unmute repairs, each with local human approval, verification and separately approved undo. Cloud approval/grant is rejected. Tests cover strict tool-only forwarding, queue/session expiry, duplicate results, no redelivery and uncertain delivered execution. Hardware source remains synthetic.
- The actual `--remote` entry point exits 2 before creating SQLite/listening when identity configuration is absent. Remote HTTP tests simulate a trusted loopback TLS proxy; no real HTTPS hosting test is claimed.
- A fresh isolated temporary install using `npm ci --omit=dev` starts the production entry point, serves the built UI and fixture API with inspection off, exits cleanly on SIGTERM, and rejects incomplete remote configuration. Vite and Playwright are absent; tsx is present. Evidence: [production-install-check.json](production-install-check.json). The optional Dockerfile and nginx template were not built/deployed/validated against real hosting.
- Safe presence-only configuration checks and explicit fixed unauthenticated HEAD probes report missing `ANTHROPIC_API_KEY` and outbound proxy denial for Anthropic/Wajo. No credentials, proxy values, response bodies or paid requests appear in [configuration-diagnostics.json](configuration-diagnostics.json). Its `configurationReady: true` describes the default local fixture profile, not configured remote identity; remote startup still fails closed.

These results establish the bounded cloud code path with synthetic identities/devices. They do not establish live Fo OAuth compatibility, a production identity-provider setup, TLS deployment or Mac hardware behavior.

### Behaviors exercised

- No device read/proposal without a temporary inspection lease; expiration and revocation block execution.
- Exact-digest approval required; denied, expired, stale, unknown and consumed plans cannot run.
- Simultaneous duplicate execute requests cause one write at most.
- State changes before/after approval invalidate proposals; undo refuses to overwrite newer state.
- Revocation during an in-flight read prevents returning data or starting a pending write; revoking and regranting cannot revive that old read. Decline takes effect during the pre-write/approval read rather than queuing behind it.
- Each write retires other authorizations; identical later state cannot revive an old approval. Pending plans also do not survive restart or replacement of the read lease.
- Shutdown cancels pre-write work, waits for already-started writes to verify/journal, and only then releases the database. A real server subprocess exits cleanly after SIGTERM and its reopened journal shows revocation and pending-plan invalidation.
- Agent status withholds stored device details after the inspection lease ends; the local human history remains available. Stdio preserves upstream safety instructions. HTTP and MCP use the same strict recipe validation, including rejecting an explicit target for active-output unmute.
- Approval consumption and an executing journal record exist before the adapter write.
- Ignored writes fail fresh-read verification; partial-write exceptions stay uncertain and cannot replay.
- History survives reopening the SQLite database; interrupted actions become uncertain and inspection/approval authorization does not survive restart.
- SQLite exclusive locking prevents a competing process from keeping a separate mutable copy of the same approval journal.
- Route changes and unmute each affect one enumerated setting. A verified repair's inverse requires a new proposal and separate approval.
- Raw HTTP requests with foreign Host/Origin or cross-site fetch metadata are denied; permission/approval routes reject missing local Origin. Tool schemas reject extra arguments and arbitrary command recipes.
- Browser: inspection → choose output → review → explicit checkbox → approve → fixture verification → reload/history → review undo → separate checkbox/approval → restored fixture → deny another repair → revoke access.
- Browser/MCP interoperability: after a real human-interface approval and an intentionally aborted browser execution request, an SDK client executes the same approved fixture plan; the open browser receives and displays the verified setting without retrying.
- Oversized requests receive sanitized 413 responses without echoing input or affecting availability.
- Mobile: 390px viewport has no horizontal overflow and explicitly reports Fo integration as unconnected.
- Automated axe WCAG 2 A/AA checks pass for consent, output diagnosis, review dialog, Fo connection, permissions and history screens. The dialog traps Tab/Shift+Tab and Escape declines. These checks are not a complete manual accessibility certification.

## Initial failures and resolutions

| Observed failure                                                                                                 | Resolution                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| npm cache could not write to the default home directory                                                          | Used a task-specific npm cache under `/tmp`; no credentials or home settings changed                                                            |
| First production build failed on an unnecessary CSS data-URL import                                              | Removed the import; subsequent production builds passed                                                                                         |
| Host-header test unexpectedly returned 200                                                                       | Node fetch did not transmit the forged Host; changed the test to raw HTTP and verified rejection. The endpoint's Host check was already present |
| First browser run found an ambiguous history-button selector                                                     | Scoped the test to navigation and gave navigation buttons explicit stable accessible names                                                      |
| Mobile navigation had unlabeled icons when text was hidden                                                       | Added explicit accessible labels; mobile browser test passed                                                                                    |
| Initial visual contrast audit failed                                                                             | Darkened text, enlarged compact text and improved dialog focus handling; final automated audits passed                                          |
| Playwright browser installation could not write to the default cache, then downloads were rejected with HTTP 403 | Used the preinstalled system Chromium; no system browser install was needed                                                                     |
| Initial standalone axe invocation rejected an implicit browser context                                           | Used an explicit browser context in the exploratory audit; final tests use Playwright's normal context fixture                                  |

### Deployment pass failures and fixes

The first new browser run found the same explanatory Fo-connection sentence in two paragraphs, making a strict text locator ambiguous. The redundant sentence was removed. A production-only install was also mistakenly run in the workspace before being repeated in an isolated temporary directory; development dependencies were restored and the full suite rerun. These intermediate results are not counted as a successful final run.

## Remaining blockers

### GCP VM preparation (local files only)

Added the review worksheet, loopback environment, systemd unit with required-mount guards, Caddy proxy and fstab templates under `deploy/gcp/`, plus [the reviewed runbook](GCP-VM.md). No product runtime code or dependencies changed. `node deploy/gcp/offline-check.mjs` passed local synthetic authentication/CSRF/Host/Origin/forwarding checks, persisted one verified fixture action through a real process restart, invalidated sessions/read consent/pending approval, confirmed database mode 0600, checked missing-mount rejection and parsed the unit with local executable paths substituted. Evidence: [gcp-offline-checks.json](gcp-offline-checks.json). The existing 56 unit/API and seven browser results above remain the last full-suite run; this preparation pass did not repeat unchanged application tests.

Caddy is absent here, so its native parser and real proxy/TLS path were not tested. No systemd service was activated, no disk mounted/formatted, no GCP identity configured, and no SDK/package installed. Actual unit sandbox behavior, VM reboot, persistent-disk mounting, installed Caddy validation, public DNS/TLS issuance, network boundaries and live Fo acceptance remain pending authorized hosting access. Read-only environment checks found no gcloud/SDK, configured GCP account/project, credential bindings/default ADC or reachable GCP metadata identity. No tokens were queried or printed.

### Real macOS build and hardware

`npm run macos:build` exited 1 with: `The CoreAudio helper can only compile on macOS. Cloud fixture mode needs no native build.` The Swift source is provided but uncompiled here. CoreAudio property support, device changes, native errors, macOS permissions, system/app output interactions, and physical audibility need actual Mac tests. No fallback to fixtures is performed in real mode.

### HTTPS hosting, credential handoff and Fo registration

The service and bounded outbound companion session are implemented and tested with synthetic credentials/devices. Remaining needs are one authorized HTTPS host/origin, actual trusted proxy peer addresses or same-host TLS arrangement, private fixture persistence, and explicit approval for real credential provisioning and personal Fo registration. The bearer path needs two distinct high-entropy credentials and an access deadline, not an OAuth provider. Session mode adds a third independent companion credential/device ID. No production credential, registration or persistent access was created.

The parent independently confirmed the exact registration and separate credential-form handoff in the current official catalogue. This cloud's own retrieval remains proxy-denied. Advertised support does not establish the actual hosted credential form/connection or live invocation. [The integration record](FO-INTEGRATION.md) separates those facts. Optional OAuth remains unverified against Fo and needs curated-provider/DCR compatibility; it is not a required hackathon dependency.

### Claude API smoke test

An earlier session authorized a minimal Haiku/Sonnet application API test. Presence-only environment checks in both the initial and resumed turns found no `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, or supported model proxy in this running task. The resumed process had no Anthropic-, Claude-, or model-proxy-named environment variables. The smoke test again exited 2 without a request. No credential files were opened, no value was printed, no credentials were moved/reconfigured, and no paid request was made.

`npm run test:haiku` exited 2 with the safe result:

```json
{
  "test": "haiku-smoke",
  "status": "blocked",
  "model": "claude-haiku-5-5",
  "reason": "ANTHROPIC_API_KEY unavailable in this process environment; no request made"
}
```

The model ID was checked against [Anthropic's official overview](https://platform.claude.com/docs/en/models/overview) on this date. The opt-in script first verifies the model's availability and Haiku line through the [official Models API](https://platform.claude.com/docs/en/api/models/list), then permits only one generation request capped at 16 output tokens with a fixed nonprivate prompt. It has no retry loop, does not read `.env` files, does not send device state, and will not use Opus or Sonnet. It is intentionally excluded from `npm run check` so ordinary tests never incur API costs. A later-injected credential must be made available through the platform's supported environment mechanism; adding it elsewhere does not establish that this running task can access it.

Optional unauthenticated network probes now traverse the nested error cause and correctly report `denied_by_proxy` for both fixed endpoints. The existing secret must be bound through the platform environment and the relevant network destination permitted before an authenticated smoke test can run. No key needs to be pasted into chat, source or command arguments. The application repair engine has no model dependency and remains usable with an MCP orchestrator.

### Model/runtime controls

The request to use GPT-6.1 Sol with extra-high reasoning and a supported 2x speed was received during implementation. This runtime exposed no verified active-model/reasoning query or supported in-turn model/speed setting. Implementation resumed in the preserved environment after the separate task could not materialize the archive; no cross-environment transfer retry was attempted. No coding subagents were created. No model switch, extra-high setting, or speed change is claimed. Parent task controls may apply supported settings on a later turn. This is distinct from the application-level Haiku smoke test.

## Delivery boundaries

Source and test work remained in this cloud workspace. No remote push, public deployment, purchase, external message, hackathon submission, account password use, credential creation, persistent pairing, security-setting change, or upload of private device data was performed. The demo server runs on loopback at `http://127.0.0.1:4310`; it is not a public URL. Screenshots contain synthetic data only and remain in the original workspace. The updated Library source archive excludes browser captures as well as credentials, `.env`, databases, dependencies, caches and Git internals.

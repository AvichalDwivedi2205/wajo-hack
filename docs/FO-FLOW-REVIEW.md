# Fo execution and private credential handoff review — 2026-10-18

This change builds on public initial commit `d308ee0465dc1cdde9b8ef90995f23797e1b0879`. It adds approval-only repair/undo review for Fo, protected owner deadline display, evidence-based integration wording and the standalone offline credential helper. No application dependency, authority, credential or deployment configuration was added or changed by this code/test pass. Actual hardware and live Fo remain unverified.

## Behavior and boundaries

- **Approve for Fo** sends only the exact plan ID/digest to the existing owner/local approval endpoint. It does not execute. The UI shows an approved/waiting state; Fo executes through `fo_fix_execute_approved`. Undo needs a fresh proposal and another explicit approval. The manual apply option remains available.
- Slow polls cannot downgrade an acknowledged approval or disable its decline controls. Acknowledged denied/consumed plan IDs are retired locally so stale status cannot resurrect their modal. Reload reconstructs an outstanding approved plan from the authoritative journal.
- `deploymentExpiresAt` is returned only through authenticated bearer owner `/api/auth`; the UI displays both owner-session and deployment expiry in explicit UTC. Existing 15-minute owner session and maximum 24-hour deployment rules are unchanged. There is no renewal or configuration endpoint.
- `fo.connected` is now null (unknown), with wording that directs users to Wajo registration and observed live tool results. It does not fabricate account state or confuse transport success with actual device repair. Legacy MCP tool IDs, status protocol name, environment names and paths are unchanged.
- `tools/offline-credentials.html` is a self-contained downloadable file, outside the served web assets. It generates two independent 32-byte random values only on an explicit click, encodes unpadded base64url, masks the values and hashes the exact UTF-8 strings. Only digests can be downloaded, after user acknowledgement that both credentials are saved in the user's vault. There are no network, telemetry, storage, cookie, clipboard automation or server configuration APIs. Its CSP pins inline code/style and denies network connections and forms.
- Clearing/pagehide invalidates pending hashing so late results cannot repopulate credentials. Errors are constant messages without values. Real user credentials were never generated in development, tests, screenshots, logs or artifacts. Helper browser tests use deterministic synthetic bytes and disable trace, screenshots and video.

Follow [CREDENTIAL-HANDOFF.md](CREDENTIAL-HANDOFF.md) for the user-controlled private generation, digest-only export, exact origin/digest/backend/deadline/restart approval, secure Fo entry and separately authorized native pairing. The server handles plaintext transiently during HTTPS authentication; digest-only deployment configuration is not a claim of no plaintext in server memory.

## Review and validation

Separate functional and security reviewers reproduced and checked the fixes. They found no remaining actionable defect in this change; this is not a security certification. Review found and resolved a pagehide/hash race, stale approval downgrade, decline blocked by a slow refresh and stale terminal modal resurrection. Tests exercise these boundaries.

The final `npm run check` passes the production TypeScript/Vite build, **70 unit/API tests and 16 Chromium tests**, with zero failures/skips. [check-output.txt](check-output.txt) contains the complete final output. New coverage includes owner-only deadline access, offline helper CSP/API restrictions, deterministic exact-string hashing and digest-only export, no network/storage activity, entropy failure, deferred-hash pagehide cancellation, SDK-driven approval-only repair/undo/revocation, delayed status, reload and UTC display. Existing auth/CSRF/MCP separation, expiration, replay, local companion and accessibility checks remain green.

`node deploy/gcp/offline-check.mjs` also passed after the changes. This is synthetic local VM/runtime preparation, not a public deployment/TLS check. Dependency versions are unchanged.

Intermediate failures were observed and corrected: a static test initially required pre-format whitespace; the managed Chromium browser refused `file://` navigation; and the delayed-poll test initially left route callbacks running during teardown. The static assertion now permits formatting, the exact standalone helper is fulfilled in memory at a loopback test URL, and routed requests drain before teardown. No app endpoint or browser security policy was added or weakened. Direct downloaded-file use remains to be validated in the user's browser.

## Deployment pin and remaining acceptance

Deploy the commit containing this review, rebuild the frontend and restart the single service; do not pin the initial `d308ee0` revision. Existing bearer configuration names, HTTPS origin/proxy contract and lifetime limits remain valid. `fo.connected: null` and owner-only `deploymentExpiresAt` are the intentional metadata changes. No real credential values are present in this source.

A complete live demonstration still needs authorized digest installation, user entry into the separate owner/Fo secure forms, actual Fo registration and tool calls, approval-only execution and independently approved undo. Synthetic fixture results must remain labelled. A real-device result additionally requires macOS compilation, a third independently authorized companion credential, local permission/approval, actual hardware verification and human audibility checks. The cloud cannot repair an offline Mac.

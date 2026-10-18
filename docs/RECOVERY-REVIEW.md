# Narrow recovery review — 2026-10-18

The saved cloud environment resumed against remote `main` at **`c8dbf2840957b982e2ccb66f017d299624d9d3e5`**, rather than the originally supplied `d308ee0465dc1cdde9b8ef90995f23797e1b0879` baseline. The requested implementation was already present in `92468e331ac8e291e1944b7bc9c5af1982877426` and its Clear-cancellation follow-up `c8dbf2840957b982e2ccb66f017d299624d9d3e5`.

This pass uses the isolated `/workspace/fo-reach-recovery` worktree and `recovery/owner-approval-credentials-reviewed` branch. Uncommitted client-review/file/demo work in the original worktree was preserved and excluded. No applicable `AGENTS.md` or `SKILL.md` was found, and the cloud/executor skill catalogues were empty. This review makes no deployment, credential configuration, DNS, GCP or Fo-registration change.

## Reviewed behavior

- **Approve for Fo** records exact plan approval without execution. Repair and undo both wait for Fo's `fo_fix_execute_approved` MCP call; undo requires a new specific approval. The separately labelled manual apply path remains available. Approval can be declined before execution.
- Acknowledged approval cannot be downgraded by an older pending status response. Retired plans cannot be reopened by a late poll. Reload recovers an outstanding approved plan from the journal.
- Integration status reports account state as unknown. Authenticated bearer owners see both session and deployment deadlines in explicit UTC; unauthenticated and MCP access cannot retrieve the owner metadata. The existing lifetime limits remain unchanged.
- The standalone [offline helper](../tools/offline-credentials.html) generates nothing on load. An explicit click requests two separate 32-byte Web Crypto random values, rejects equal values, encodes unpadded base64url, masks the displayed credentials and hashes each exact UTF-8 token string without adding a newline. Its export contains only the two SHA-256 settings. The env-file line endings are not part of either hashed token.
- The helper has no network calls, persistence, cookies, analytics, external assets or configuration endpoint. Clear and pagehide invalidate pending work; late hash success or failure cannot restore cleared values or change a newer generation. Browser tests use deterministic synthetic bytes and disable secret-bearing captures. No real user credentials were generated or read.

## Additional regression

The earlier approval test held requests before fetching their responses. That checked responsiveness during a delayed refresh, but did not deliver a genuinely old pending snapshot after approval acknowledgement.

The new browser regression captures two actual pending response bodies before approval and holds newer refreshes. It delivers the first captured response after approval acknowledgement, verifies the approved waiting state and enabled Decline control, then delivers the second after decline. The modal stays closed, MCP execution is denied and the browser has sent zero execution requests. Existing tests continue to cover separately approved repair/undo execution, reload, revocation, both pending hash stages and stale hash results after Clear/pagehide.

## Validation

Full results are recorded in [recovery-check-output.txt](recovery-check-output.txt): production TypeScript/Vite build passed, **70 unit/API tests passed**, and **22 Chromium tests passed with one explicit file-policy skip**, zero failures. The new captured-response regression also passed in isolation. Node.js was `24.19.0`, npm `11.9.0`; dependency versions did not change.

Separate read-only security and functional reviewers inspected the scoped implementation and regression. Security checks included eight focused helper/bearer tests, the seven passing helper browser checks, CSP pin validation and 24 synthetic VM cancellation interleavings. Functional checks included 45 affected tests, 21 independent synthetic helper VM cases and inspection of the new captured-response regression. Neither reviewer reported an actionable finding in the narrow change.

`node scripts/pin-credential-helper.mjs` and `git diff --check` passed. A fresh `npm audit --omit=dev` reported zero known production vulnerabilities, matching [production-audit.json](production-audit.json). The [source-pattern scan](recovery-secret-scan.json) found no unresolved known secret patterns; two existing explicitly synthetic credentialed-URL test interpolations were reviewed and allowlisted. It read repository source only, without environment values, ignored private state or stash contents. Pattern scanning is not proof that every possible secret is absent.

The synthetic local `node deploy/gcp/offline-check.mjs` passed authentication/authority separation, CSRF/forwarding guards, private database permissions, restart persistence and revocation, mount guard and substituted local systemd syntax checks. Caddy binary validation remains unavailable. This script did not change GCP or contact public TLS endpoints.

## Remaining acceptance

Managed Chromium blocks the direct `file://` helper test with `net::ERR_BLOCKED_BY_ADMINISTRATOR`; only that explicit policy failure is skipped. The exact self-contained HTML passes in-memory loopback browser checks. A downloaded-file run in a browser permitting local HTML remains pending; browser policy was not weakened and no helper endpoint was added.

Actual Mac hardware and live Fo execution remain unverified. The app remains inactive pending separately approved user credential configuration and registration. Existing server/DNS infrastructure is not changed by this review. Follow [the credential handoff](CREDENTIAL-HANDOFF.md) for the private user-controlled next step; this branch does not authorize it. Main is left for parent coordination, and the reviewed recovery branch is published without force-pushing.

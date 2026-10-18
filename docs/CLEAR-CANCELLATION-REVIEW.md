# Offline helper Clear cancellation review — 2026-10-18

This narrowly scoped follow-up starts at `92468e331ac8e291e1944b7bc9c5af1982877426`. Independent cloud verification reproduced a gap: Clear was disabled during hashing, and its handler ignored pending work. The existing late-result regression exercised pagehide, not a user pressing Clear during hashing.

## Change

Clear is now available as soon as the user starts generation. Clearing invalidates that generation, removes displayed credentials and digests, resets the save/export controls and allows another explicit Generate click immediately. Results are checked after each hash; a cancelled first hash cannot start the second one. Late success, rejection and cleanup from an older operation cannot overwrite a newer generation's values, errors or busy state. Current-generation failures leave an accurate idle/retry message and permit an explicit retry.

The helper still generates only on a user click, uses separate 32-byte Web Crypto random values encoded as unpadded base64url, masks credentials, hashes the exact UTF-8 strings without a newline, and exports only the two digest settings after the user's save acknowledgement. CSP has been re-pinned to the exact inline source. There are no added network, persistence, cookie, clipboard, analytics, credential-configuration or application APIs. No dependency, server authority, GCP setting or Fo registration changed.

## Regression and independent review

The browser tests use deterministic synthetic bytes with trace, screenshots and video disabled. They now explicitly hold the first or second hash, click the real Clear button, release hashing and verify that fields stay empty and export stays disabled. Further tests hold a newer generation while the cancelled operation succeeds or rejects, verify that the newer operation is preserved, and exercise current-generation hash failure and retry. The pagehide regression also confirms that cancellation after the first hash prevents the second hash from starting.

Separate read-only security and functional reviewers inspected the final fix. Security review passed 24 deterministic VM interleavings; functional review passed 16. These cover Clear/pagehide, both hash stages, stale success/rejection and newer pending/completed generations. Functional review found the stale “Generating” message on a current failure; that finding was fixed and its hash-failure/retry and entropy-failure assertions added. Both reviewers reported no remaining actionable findings. These reviews are bounded checks, not a security certification.

## Final validation and limits

- Affected helper browser suite: **7 passed, 1 policy skip**, zero failed.
- `npm run check`: production TypeScript/Vite build passed; **70 unit/API tests passed**; **21 browser tests passed, 1 policy skip**, zero failed. Complete output is retained in [check-output.txt](check-output.txt).
- `node scripts/pin-credential-helper.mjs` and `git diff --check` passed.
- `node deploy/gcp/offline-check.mjs` passed its synthetic local checks. Caddy binary validation remains unavailable; no cloud or public TLS action ran.
- Repository source was scanned for known private-key, provider-token and credentialed-URL patterns. No unresolved match remained; two existing explicitly synthetic URL interpolations in the diagnostics test were reviewed and allowlisted. No environment values, ignored private state or stash contents were scanned. Pattern scanning cannot prove that every possible secret is absent.

The new portable direct-file test attempted the actual standalone `file://` URL. This environment's managed Chromium refused it with `net::ERR_BLOCKED_BY_ADMINISTRATOR`. The test skips only explicit file-access policy failures; other navigation or helper failures fail the test. The exact HTML is exercised through in-memory loopback document responses for the passing browser checks; there is no app helper endpoint and browser policy was not weakened. Direct downloaded-file behavior still needs a run in a browser that permits local HTML.

No real user credentials were generated, stored, printed or installed. macOS hardware, live Fo calls and separately approved deployment credential configuration remain unverified. The app has not been activated by this code change.

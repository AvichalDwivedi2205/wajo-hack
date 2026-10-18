# Three-role offline helper review — 2026-10-18

The session gateway needs three distinct role digests. The earlier helper generated only owner/MCP credentials, leaving companion setup incomplete. The updated `tools/offline-credentials.html` creates owner, MCP and companion values only after the user's explicit click and exports exactly these digest labels:

```text
FO_FIX_OWNER_TOKEN_SHA256
FO_FIX_MCP_TOKEN_SHA256
FO_FIX_COMPANION_TOKEN_SHA256
```

Each value comes from a separate 32-byte Web Crypto random call and is encoded as 43 unpadded base64url characters. All three pairwise collisions fail before hashing/export. Each digest covers the exact UTF-8 credential string, without a newline. Mask/reveal/reset/blur/pagehide include all roles, and a generation guard follows every awaited digest so Clear cannot be undone by stale work.

The export contains no plaintext, origin, device ID, backend or expiry. No network, persistence, telemetry, clipboard automation, configuration, registration or companion launch capability was added. Device ID, exact expiry, backend, digest installation and pairing remain separately approved actions. The updated [credential handoff](CREDENTIAL-HANDOFF.md) describes all three role destinations, including transient plaintext in the companion Authorization header.

## Verification

- `node scripts/pin-credential-helper.mjs`: exact inline script/style CSP hashes match.
- Targeted helper browser checks: **18 passed**, including direct downloaded-file use on the Mac.
- Aggregate `npm run check`: production build, **150 unit/API/relay tests** and **37 browser tests passed**, zero failures/skips on this Mac.
- Tests replace randomness with deterministic synthetic byte vectors and disable screenshots, traces and video. They cover all three pending-hash Clear stages, old success/failure against newer work, each current hash failure, every duplicate pair, exact digest-only downloads, masking, no network/storage activity, reload and pagehide.
- Two independent read-only reviewers found no remaining actionable security, standards or spec issue after the handoff's companion authentication-channel explanation was corrected.

No actual user credentials were generated or configured. No production app activation, deployment, registration, permission change or credential installation occurred.

## File identity for the separate download-only deployment

Full-file SHA-256 of `tools/offline-credentials.html`:

```text
d09991a3340d96bb8dfce2302f8981631443a87ebb1b2ad01563ffbec4ec5606
```

Deploy only the reviewed downloadable HTML through the separately authorized deployment task. The file hash identifies the complete source bytes, including its pinned CSP. Replacing the public helper is separate from configuring or activating the application.

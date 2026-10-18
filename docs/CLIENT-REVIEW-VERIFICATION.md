# Client-review implementation and cloud verification — 2026-10-18

Starting remote `main` was `c8dbf2840957b982e2ccb66f017d299624d9d3e5`. The useful credential/stale-poll regression from recovery commit `c1c35354682aa270f51d239412f04b8c6a4e6dfe` is preserved on the feature branch as `6b87fcddf1980886799742dc2a17aac390a33de9`. The later user authorization explicitly supersedes the old credentials-only scope for source development. Earlier recovery documents remain historical; this feature now includes the approved client-review extension. Main is left for parent coordination.

## Gap audit and resulting implementation

| Audio baseline gap | Completed source behavior |
| --- | --- |
| No file discovery or parsing | Ten explicit manifest sources, three independently permitted folders, bounded XLSX/CSV/PDF/PNG parsing and identifier-based selection |
| No cross-file metric reconciliation | Unique visitor/transaction proof; matched qualifying refunds; exact 540/12,000 = 4.5%; PDF evidence of old 5.5% claim; unchanged 5% gate |
| No presentation review | Complete branded three-slide preview, before/proposed images, source/row evidence and exact approval digest |
| Synchronous audio execution semantics | Queued durable review jobs, bounded worker, no write replay, interruption/uncertainty recovery and separately approved artifact undo |
| Audio-only relay | Five optional strict `review.*` tools, DTO/payload limits, local-only permission/approval and binary viewing |
| No constrained native presentation adapter | Fixed Objective-C ScriptingBridge source, pinned recipe/dictionary/version, staged-source hashes, validated slots, copy/save/export/render/receipt and native-only readiness audit |
| No usable Keynote template in cloud | Real three-slide PPTX seed and bounded manual Mac import/bind recipe; genuine `.key`/native acceptance explicitly pending |
| Source-checkout writes / resource gaps | Explicit app-data setup, exclusive descriptor-anchored Linux output writes, parser subprocess limits and bounded concurrency |

The [complete demo and native handoff guide](CLIENT-REVIEW.md) describes supported formats, commands, limits and exact pending gates.

## Final checks

`npm run check` passed the production TypeScript/Vite build, **115 unit/API/relay tests** and **26 Chromium tests**, with zero failures. One additional direct-file credential-helper test is explicitly skipped because managed Chromium blocks `file://`; the exact helper still passes its in-memory loopback tests. Full output is recorded in [client-review-check-output.txt](client-review-check-output.txt). The suite includes the pre-existing audio, authentication, owner approval, credential-helper and cancellation coverage. Linux native build/audit guards correctly refuse to claim Mac verification.

New review tests cover exact arithmetic/selection; duplicate and unmatched IDs/refunds; cutoff/calendar/cohort errors; cached/empty/namespaced formulas; macro/external-reference parts; actual ZIP expansion; contradictory PDFs; PNG dimension/chunk/alpha/blank checks; PDF page-count metadata spoofing; omitted/misplaced approved text and leftover slots; source/path/symlink changes; approval-only execution; expiry/deny/revoke races; worker timeout/drain/restart; physical cached-receipt recovery; bounded preview reads; setup without overwrites; adapter-entry ancestor swaps with zero external output; consumed-undo shutdown draining; and actual qualifying refund row references after a pending row is excluded.

The authenticated SDK test completes three synthetic gateway/companion runs. Its first adapter intentionally lasts 26 seconds, beyond the old 25-second audio timeout; commit returns a job promptly, verify reports running, and final verification checks three PDF pages/renders and unchanged originals. This demonstrates cloud protocol behavior, not real Fo or native execution.

Four review browser tests cover approval-only creation/SDK execution/undo, local consent, stale polls, in-flight revoke/regrant, repeated previews, exact image readiness/error handling, accessibility, mobile layout and rendering. The preserved audio regression independently delivers captured pending bodies after approval and decline. Offline credential tests still use deterministic synthetic bytes and disable secret-bearing captures; managed Chromium's direct-file policy limitation remains separately disclosed.

Independent read-only security, functional and native-source reviewers identified and verified fixes for formula aliases, actual ZIP expansion, contradictory brief/rule text, invalid dates, grant/approval/revoke races, output/receipt freshness, timeout draining, image readiness, transparent/flat page detection, PDF metadata spoofing, native recipe preflight/rich-text/geometry/error handling, output ancestor races, undo shutdown and refund row traceability. They reported no remaining actionable cloud/source finding after those fixes. Native source review is not compilation or hardware validation.

Security independently passed the 42-test review/relay suite before the final three regressions, then all three new regression tests. Functional review passed its separate workflow/UI probes, main-entry app-data flow, regenerated fixtures, row-trace and ancestor-swap reproducers. Native source review checked helper SHA-256 `e109227f6eed6371c2c96aebadbf04ae93c1714bc4d1da6274ef2c60b04a4876`, including request/preflight/source-hash/geometry/receipt guards. No reviewer edited source.

The functional reviewer also passed the actual main entry point with an explicit app-data root and clean SIGTERM; regenerated the ten fixtures without overwriting on repeat; imported/rendered the PPTX seed using Linux LibreOffice; and visually inspected all three filled-seed and synthetic PDF pages. Root also viewed all three synthetic renders. The comparison hypothesis, metric, owner/readout and footers fit. Cloud render checks do not establish native image fidelity.

Production dependency audit reports zero known vulnerabilities in [client-review-production-audit.json](client-review-production-audit.json). CSP pins and whitespace checks pass. [The source secret-pattern scan](client-review-secret-scan.json) covers repository text and the generated fixture archives/PDF text, without environment values, ignored private state or stash contents. Pattern scanning cannot prove that every possible secret is absent. No real user credentials or personal files were used.

## Boundaries and acceptance

No Mac access/wake, native execution, permission changes, production credentials, GCP changes or Fo registration occurred. The source is ready for the reviewed cloud demonstration; native/live readiness remains false. Actual dictionary compilation, real `.key` import/slot behavior, stable Automation access, native screenshot/render verification, five cold starts and three actual Fo round trips remain pending exactly as described in the handoff. Keynote pathname operations retain the disclosed concurrent same-OS-user mutation limitation. The existing app remains inactive pending separately approved user credential configuration and deployment coordination.

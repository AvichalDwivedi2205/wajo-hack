# Native Mac acceptance checkpoint — 2026-10-18

Baseline: `dab01b64cd74c1d7185171650ed4a8b337fde3ec`, fetched into an isolated checkout on the user's Mac. Work is on `native/client-review-mac-verification`; nothing is merged, deployed, recorded, or submitted.

## Capability and fixes

The actual host runs macOS 26.3 (25D125), arm64, Keynote 14.4 (7043.0.93), and Node 25.6.1. The installed Keynote dictionary SHA-256 is `312b8fb57cf06549a1be69c39e91afb48d7fcf8f3a0553ebc02289953c2d16d8`.

Native execution exposed faults that the Linux checks could not establish:

- `KeynoteDocument` has no `exists` selector. The fixed helper now calls the dictionary's application-level `exists:` command.
- Cocoa rewrites canonical `/private/var` and `/private/tmp` paths to symlink aliases when standardizing strings. The helper now validates lexical components and still checks every actual ancestor for symlinks. Native regression coverage exercises canonical temporary paths, symlink rejection, and traversal rejection.
- AppKit drawing into the three-channel bitmap produced a completely black render. Direct PDFKit/CoreGraphics rendering into a supported buffer, followed by an explicit RGB sample copy, produces actual visible pages.
- macOS's PNG encoder adds `eXIf` metadata. Only generated EXIF metadata is removed; pixel-bearing chunks and the strict validator for source PNGs remain unchanged.
- Synthetic tests on Mac did not select the mandatory read-only native PDF helper. The fixed default selects only its read-only PDF commands, never a native writer or a fallback from failed Keynote execution.
- The Swift compiler's default module cache was outside the workspace. The build now uses its own `.build/ModuleCache`.
- Recursive APFS cleanup reproducibly failed while unlinking both hardlink names concurrently. The test removes its disposable alias sequentially after all rejection assertions.
- ScriptingBridge's Apple-event timeout is expressed in ticks. The native helper now specifies `60 * 60` ticks for the intended sixty-second event bound. Actual export behavior after this last correction remains pending.

The added `automation-status` command checks only the fixed Keynote target and never prompts. The user's explicit local approval allowed one separate setup prompt. The subsequently rebuilt helper reported `authorized: true`, `status: 0`, `promptAllowed: false`. No other access or persistent credential was configured.

## Actual results

| Stage | Result |
| --- | --- |
| Production TypeScript/Vite build | Passed |
| CoreAudio helper compilation | Passed; no audio state was changed |
| Actual Keynote dictionary extraction and helper compilation | Passed after the selector correction |
| Native PDFKit read/render regression checks | 2 passed, including visible RGB pixels and path rejection |
| Full unit/API/relay suite on Mac | 147 passed, 0 failed |
| Full installed-Chrome browser suite on Mac | 27 passed, 0 failed, 0 skipped; includes direct-file credential-helper test with synthetic bytes |
| Synthetic fixture staging and identical repeat setup | Passed |
| Import seed into actual Keynote and save new `.key` | Passed through native UI |
| Native source reconciliation and local exact approval | Passed; 540 / 12,000 = 4.5%, unchanged 5% gate |
| Local SDK commit to real Mac adapter | Queued then uncertain; never described as a real Fo round trip |
| Native template copy and opening | Copy exists, matches original bytes, and its actual Keynote document was inspected |
| Fixed template slot contract | Failed: imported file exposes six text items per slide, including two hidden empty zero-size placeholders, and changes text geometry |
| Native production copy editing and PDF export | Not passed; the helper stopped before those stages |
| Separate template preparation probe | Partial changes only in a disposable copy; Keynote reported a save/export permission error and UI automation timed out. Original remains unchanged |
| Five accepted cold-start runs | 0 / 5; never run to acceptance |
| Native stale-source, deny/revoke, interrupted-export gates | Never run to acceptance; synthetic tests do not establish them |
| Three actual Fo → relay → Mac → Fo runs and approved undo | 0 / 3; never run |

The first native job is `06e3b57a-af46-4593-b25d-ea46657d5be5`, from plan `ee570839-1432-477c-ba6a-fc5a492586c8`. Its uncertain artifacts and consumed approval are preserved. No export retry was made. No native PDF or success receipt exists for that job.

Twelve bundled fixture/manifest/seed hashes were recorded and rechecked unchanged. The newly saved original native template SHA-256 is `0289b76a142d5a445b5560a5b81176c2318f17e357fb7c4b71ea815874b55980`; it was rechecked unchanged after the preparation probes. No personal file search was performed.

Raw local build/test logs, native inspection JSON, regression outputs, initial black raster and repaired visible raster, hashes, and isolated preparation probes are preserved in `../native-evidence/` relative to the checkout. Test app data and uncertain generated artifacts are under `../native-data/`. These local generated files are deliberately outside public source.

## Readiness

`nativeReady`, `liveFoReady`, and `readyForLiveDemo` remain false. A simulation does not satisfy the user's requested alternative. Recording must use a working real path. Production activation still requires the separately controlled digest-only credential export, exact approved expiry/configuration, reviewed source deployment, and authorized Fo registration. None was attempted here.

## Independent audit and actual PowerPoint alternative

Two independent read-only reviewers audited `dab01b6...d0822f8`. The standards reviewer found no actionable new standards or safety defect. The spec reviewer identified the unmet template contract and all remaining native/live gates; it did not certify readiness. Both confirmed that the permission alert alone is insufficient evidence for broader system permissions.

After the user reported that Keynote was force-quit and authorized evaluating PowerPoint, isolated ordinary-save probes ran on a fresh disposable `.key` in `/private/tmp`. `saveIn:nil as:0` returned Apple-event `-1700` (coercion failure); the valid native format with no destination returned `-1715` (parameter not accessed). Neither establishes a successful save. The original saved template remains hash-identical. No broader permission was granted and no uncertain production export was retried.

PowerPoint and LibreOffice are not installed. A **real editable PPTX feasibility proof** succeeded without controlling either app. The development-only generator at `.fo-fix/pptx-proof.ts` updates the genuine OOXML seed with the exact previously approved slide text and original screenshot bytes, writes a new `.pptx` exclusively, and verifies complete text and image hashes. This is file-level feasibility work outside the guarded job engine, not a fresh approved Fo execution.

macOS `qlmanage` successfully rendered the actual generated PPTX into its genuine three-slide Quick Look preview. A fresh headless Chrome process captured each actual slide and printed that preview into a three-page PDF. Native PDFKit extracted the correct complete text. Root and an independent read-only reviewer inspected all three rendered slides. The reviewer additionally checked every editable text shape, image, ZIP part, preview attachment, and normalized PDF page text. Only the three slide XML parts differ from the seed; the two images retain the source bytes.

The evidence is under `../native-evidence/pptx-proof/`: `Alder-client-review.pptx`, `Alder-client-review.pdf`, `verification.json`, three slide PNGs, and the actual `.pptx.qlpreview/` output. PPTX SHA-256 is `0daa803a059cb94e75d11b3b0895b189bccfc46d8d4bee78e032018f6e607a6d`.

This establishes a viable **genuine document-generation** alternative, not a Keynote export or successful PowerPoint-app edit/resave. It still needs a separately identified adapter integrated with fresh exact approval, bound template and destination, exclusive writes, independent verification, uncertainty handling, and separately approved undo. Existing Keynote acceptance remains failed, and actual Fo round trips remain zero.

The user requested debating a relatable real-problem demo with Claude after the Mac audit. The prepared brief is under `../native-evidence/claude-demo/brief.txt`. Automatic approval review initially rejected its external disclosure; the user then explicitly approved that exact brief. The attempted consultation subsequently returned `Not logged in`; a filtered local status check confirmed `loggedIn: false`, `authMethod: none`. No Claude response or debate exists. No credential was generated or requested in chat. Claude account sign-in is a remaining user-controlled dependency.

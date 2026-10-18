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
| Full unit/API/relay suite on Mac | 150 passed, 0 failed, including actual PPTX rendering, tamper rejection and undo |
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
| Explicit PPTX app integration | Passed: actual editable OOXML, system Quick Look preview, Chrome PDF print, PDFKit verification and separately approved undo |
| Restarted local browser/UI/MCP SDK PPTX acceptances | Three consecutive passes; each starts a fresh server/browser process. These are not real Fo or Keynote runs |

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

That checkpoint established a viable **genuine document-generation** alternative, not a Keynote export or successful PowerPoint-app edit/resave. The subsequent integrated implementation and acceptance below supersede the earlier file-only limitation. Existing Keynote acceptance remains failed, and actual Fo round trips remain zero.

The user requested debating a relatable real-problem demo with Claude after the Mac audit and explicitly approved the prepared brief under `../native-evidence/claude-demo/brief.txt`. An early local `--bare` invocation reported signed out because that flag disables OAuth and Keychain reads. The corrected local `claude --safe-mode --print` call used the existing login successfully, with tools/integrations/custom instructions disabled and no saved session. Its critique is preserved in `local-host-safe-response.txt`. Parent also completed browser debate at `https://claude.ai/chat/008fcccf-408d-4d50-b154-100b03e16b6c`. No credential was created or disclosed.

## Integrated PPTX acceptance and independent audit

`--review-pptx` explicitly selects a separate real adapter and fresh manifest with `outputKind: "pptx"`; it never switches after a Keynote failure. The fixed seed receives actual editable text paragraphs and exact source PNGs. Recipe identity is checked before creating the first artifact. After consumed approval, Quick Look renders the generated deck in a private temporary folder and Chrome prints that preview from a disposable profile. PDFKit checks the PDF and produces the stored page PNGs. There is no application mock, image-only deck, renamed HTML, Keynote call or claimed PowerPoint application edit/resave.

The existing source/directory identity checks, fresh exact approval, expiry/revocation, exclusive no-follow writes, unique job destination, consumed-plan behavior, uncertainty preservation and separately approved hash-checked undo remain active. New strict relay metadata rejects a contradictory output kind or recipe. Verification compares the complete PPTX to regenerated approved bytes, checks complete three-page PDF text, independently rerenders each PDF page and binds all six artifacts, including the physical renderer receipt, to the final inventory. Receipt evidence is stored as `pptxEvidence`; it cannot satisfy the Keynote audit's `nativeEvidence.coldStart` requirement.

Two new regressions cover fresh setup/no overwrite, adapter-mode mismatch, unapproved refusal with no artifacts, recipe-drift refusal with no artifacts, editable OOXML/image bytes, actual Mac system rendering, complete output verification, tamper refusal, consumed approval and separately approved undo. The added strict test-gateway regression also passes three real PPTX/PDF runs with ephemeral test identity, metadata-only relay results, refusal of authenticated remote artifact access and separately approved local undo. This is test-gateway proof, not production Fo. The full Mac suite passed **150/150**; the existing browser suite passed **27/27**. Three consecutive separate fresh-server/browser runs of `playwright.pptx.config.ts` passed local permission/approval, MCP SDK commit, actual PPTX/PDF downloads, independent verification, duplicate/unapproved refusal, new undo approval, unchanged sources and zero browser-issued commits/errors. Exact result logs and captured deliverables are in `../native-evidence/pptx-browser/` and `pptx-browser-current-final-run-{1,2,3}.txt`.

Both read-only independent reviewers audited the integrated route. They caught a preflight ordering fault (the first PPTX could be written before recipe-drift refusal) and premature completed wording in status. Both are fixed; the zero-artifact regression covers the ordering. Both reviewers reported no remaining actionable finding. Root and the spec reviewer independently inspected all three actual stored PDF renders and found the metric, original comparison images, owner/readout and footers readable. Automated acceptance leaves `visualApproved` false; it does not manufacture human sign-off.

The local preview at port 4310 now uses the explicit PPTX route with a separate `../native-pptx-data/` source root and journal. Earlier `../native-data/` Keynote sources, original template and uncertain job remain preserved. Original fixture and native-template hashes were rechecked unchanged after integration. The branch was published only after the user's explicit approval; nothing was merged or deployed.

## Demo decision and remaining blockers

The demo should center on **a stale number that would change a client recommendation**. Current source rows and the existing rule produce 4.5% retained conversion, below the 5% gate, while the prior handout claimed 5.5% gross. A local exact approval then produces the useful editable deck/PDF, preserves originals, and supports separately approved removal. This is a bounded synthetic Alder workflow, not general-purpose document ingestion. Claude's suggested arbitrary perturbed-dataset demonstration is outside this fixed cohort/parser contract; do not claim it works without implementing and testing it.

The [demo plan](CLIENT-REVIEW-DEMO-PLAN.md) uses the real source evidence and output path. It removes a manufactured countdown and raw terminal theatrics. Recording remains blocked by actual Fo registration and three real Fo → relay → Mac → Fo runs with approved undo, plus separate configuration/expiry approval and credential delivery controlled by parent. Keynote remains **0/5** and Fo **0/3**. No production configuration, recording or submission was performed.

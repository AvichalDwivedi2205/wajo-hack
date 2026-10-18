# Client review: cloud demo and native handoff

The implementation prepares a bounded Alder client review. It reconciles ten synthetic sources, previews three slides, obtains exact local approval, and exposes asynchronous review jobs through MCP. The Linux HTML/PDF result is explicitly a simulation. On the audited Mac, the explicit PPTX route creates a real editable PowerPoint deck and PDF. Keynote compilation passed but its imported template/save/export acceptance failed. See the [Mac audit](CLIENT-REVIEW-MAC-2026-10-18.md) for current evidence and separate live Fo gates.

## Actual editable PowerPoint/PDF route on Mac

Requirements: macOS, installed Google Chrome at its standard application path, the compiled read-only PDF helper (`npm run macos:review:build`), and a fresh private synthetic review root. PowerPoint, Keynote Automation and additional OS permissions are not required for this route. It does not edit/resave in the PowerPoint application or export through Keynote.

```sh
# Parent directory must already exist. Setup refuses an existing root.
npm run review:pptx:setup -- /exact/new/app-data/client-review
FO_FIX_DATA=/exact/new/app-data/pptx.sqlite \
FO_FIX_REVIEW_ROOT=/exact/new/app-data/client-review \
npm start -- --review-pptx
```

The mode is explicit: no failed Keynote job is retried or converted. The UI says **SYNTHETIC DATA / EDITABLE POWERPOINT**, and snapshots/jobs carry `outputKind: "pptx"`. Approval binds the full source snapshot, exact output kind, fixed recipe hash, slide text, unique destination and expiry. All output writes occur after approval is consumed. Original files and earlier native journals remain separate.

The fixed, SHA-pinned OOXML seed receives editable text runs and the exact two source PNGs. The app checks recipe drift before writing any artifact. System Quick Look previews the generated `.pptx` in a fresh private temporary folder; a new headless Chrome profile prints that actual preview to PDF with network host resolution blocked. No personal browser profile is read. Only the guarded output writer publishes bytes into the approved job directory.

Verification compares the entire PPTX to deterministic regeneration from approved text/images/template, checks complete PDF text and exactly three pages with PDFKit, and compares three separately rendered PDF page PNGs. A physical `receipt.json` binds the recipe, renderer/version, PPTX and PDF hashes into the final artifact inventory. This proves file contents and correspondence, using repeated invocations of the same generator/rendering library; it does not substitute for actual visual inspection or prove PowerPoint application edit/resave. Verified PPTX download and PDF/page viewing remain local-only. Undo requires a fresh exact local approval and refuses changed or unrelated files.

Run actual browser/SDK acceptance after setup:

```sh
FO_FIX_REVIEW_ROOT=/exact/new/app-data/client-review \
npx playwright test -c playwright.pptx.config.ts
```

The test starts the actual local app, uses local UI approval and MCP SDK execution, downloads and independently verifies genuine files, checks duplicate/unapproved refusal, then separately approves undo and verifies original hashes. It is **local SDK proof**, not a Fo account round trip. Actual Fo registration, three live Fo → relay → Mac → Fo runs, and their approved undo are still required before recording. PPTX tests never count toward five Keynote cold-start runs.

## Run the cloud demonstration

Use Node.js 24+, the pinned npm dependencies, `/usr/bin/python3`, and Poppler's `/usr/bin/pdfinfo`, `/usr/bin/pdftotext` and `/usr/bin/pdftoppm`. The review-only system executables are present in the selected cloud environment; npm does not install them. The ordinary audio fixture does not require Poppler.

```bash
npm ci --cache /tmp/fo-reach-npm-cache
npm run build
npm run review:demo
```

Open the local loopback interface at `http://127.0.0.1:4310`, choose **Client review**, and explicitly allow the three displayed folders. A separate file lease is required; audio permission grants no file access. Inspect the exact revisions, prepare the preview, load both comparison images, and check the specific approval box. **Approve review for Fo** only approves. The MCP caller must subsequently use `review.commit`; there is no execution button in the review interface.

`review:demo` explicitly runs `review:setup` before the server. Setup copies only the public bundled source files into `.fo-fix/client-review`, or `client-review` beside an explicitly configured `FO_FIX_DATA` database. It reuses identical sources and refuses changed existing sources; it never overwrites them or grants authority. Generated jobs stay under that data root's `Deliverables/review-<UUID>` directories, rather than the source checkout. Normal server startup does not stage files. Temporary PDF subprocess inputs use private, mode-0700 directories with mode-0600 files and are removed afterward.

For an ephemeral journal, run `FO_FIX_DATA=:memory: npm run review:demo`. Source and output files still live under `.fo-fix/client-review`. `npm run review:dev` starts the development UI after the same explicit setup. The cloud demo uses no real credentials or hardware. Do not point it at personal work files; this implementation deliberately supports the synthetic contract described below.

## Sources and deterministic finding

The manifest lists ten files across exactly `Metrics`, `Brief` and `Creative`. Extra files are not discovered or read. Explicit role, revision, current/superseded status, cohort, cutoff and SHA-256 hashes determine selection; filesystem modification time does not.

| Role | Bundled evidence |
| --- | --- |
| Metrics | Current `metrics-r2.xlsx` and superseded `metrics-r1.xlsx` |
| Refunds | Final `refunds-r2.csv` and superseded `refunds-r1.csv` |
| Brief/handout | `client-brief-r3.pdf`: client facts plus a separately labelled prior-slide handout page recording 5.5% gross conversion |
| Measurement | `measurement-r2.pdf`: retained-v1, existing 500-basis-point gate |
| Notes | `notes-2026-10-18.txt`, treated as untrusted supporting text |
| Comparison | Approved-before and proposed checkout PNGs, separately identified in the manifest |
| Template | Honest synthetic JSON contract in cloud; replaced by a hash-bound candidate `.key` archive only during explicit Mac setup |

The supported workbook has exactly `Meta`, `Visitors` and `Paid` sheets, plain bounded cells and contiguous explicit rows. The implementation verifies 12,000 unique visitor IDs, 660 unique paid transaction IDs and one payment per visitor. It joins refunds to transaction IDs, rejects duplicate/unmatched rows and inconsistent amounts/cohorts/cutoffs, and counts only settled full refunds. The 120 qualifying refunds leave **540 retained visitors / 12,000 = 450 basis points = 4.5%**. Pending or partial refunds do not count; a partial amount must be strictly less than its matched payment, including pending rows; the evidence view reports the actual qualifying CSV row ranges. No floating-point rounding determines the decision.

The PDF handout supplies the historical 5.5% claim without claiming a native Keynote read. The rule and brief must match complete, unambiguous contracts; conflicting or extra rule/ownership statements fail closed. Formulas, cached formula cells, macros, external workbook references, unsupported archives and invalid calendar dates are rejected. This is a bounded demonstration parser, not general Excel/PDF ingestion.

The cream, dark-green and amber preview contains:

1. The corrected retained metric, historical discrepancy, existing 5% gate and **hold** decision.
2. Both approved comparison images, with the proposed design explicitly labelled a hypothesis and no measured uplift claim.
3. Maya Chen, instrument/test/readout timeline, 2026-10-25 readout and unchanged decision rule.

Concise footers bind the source digest, cohort, rule and cutoff; the companion evidence view identifies full hashes, source cells and exact qualifying refund rows. No launch, email or account operation is implemented.

## Approval, jobs and relay

The approval digest binds the complete snapshot, source hashes, three-slide preview, exact destination, expiry, fixed recipe source hash and create/undo direction. Source bytes and directory identities are rechecked before approval and writes. File access lasts at most 20 minutes; each plan lasts five minutes. Regrant, revoke and restart invalidate outstanding approval. Old polls and image events cannot restore retired plans or reuse another plan's image readiness.

| Tool | Strict arguments | Result |
| --- | --- | --- |
| `review.snapshot` | `{}` | Bounded source/metric evidence after local permission |
| `review.prepare` | `{snapshotId}` | Exact three-slide proposal and destination |
| `review.commit` | `{id}` (approved plan) | Journaled job; native export continues asynchronously |
| `review.verify` | `{id}` (job) | Current bounded state or explicit verification of existing output; never reruns export |
| `review.undo` | `{id}` (job) | New removal proposal requiring its own exact local approval and commit |

These five tools are added only when review is enabled. The five existing audio tools and their identifiers remain compatible. Enable review on a session gateway with `FO_FIX_REVIEW_ENABLED=1`; the gateway forwards only the strict allowlisted DTOs. It does not stage/parse source files, grant file permission, show local binary artifacts or approve anything. Remote fixture mode with review enabled is refused. File access and approval belong to the local companion, including during a relay session. This source task changes no gateway configuration or credentials.

The engine consumes approval and saves a queued job before side effects. Only one export runs at once. Native helper execution is limited to 90 seconds inside a 120-second job deadline; native Apple events have a 60-second timeout. An uncertain result is preserved, never automatically replayed. A timed-out worker keeps its slot until the actual adapter drains. Shutdown also waits for serial undo/inspection work before closing the journal. A Keynote operation already received by the OS may finish after interruption; inspect its artifacts rather than retrying blindly.

Verification checks exactly three PDF pages and the complete approved text in each page's fixed reading order, including synthetic branding/disclosures where applicable. Whitespace and case are normalized; extra, missing, misplaced or contradictory extracted text and leftover template markers fail. A separate bounded renderer invocation reads a private copy of the exact inspected PDF bytes, and each numbered PNG must match that page's dimensions and decoded RGBA pixels as well as pass the nonblank check. Different compression or RGB/RGBA encoding is permitted when the decoded samples match. This is an independent invocation of the same platform rendering library, not a second rendering engine; color-management metadata is not compared.

Synthetic HTML and JSON must match the deterministic approved slides and selected source-image bytes exactly. Checked PDF/PNG/HTML/JSON hashes must match the final inventory before either initial success or explicit recovery can promote a job. Native promotion also rereads the physical recipe receipt, even when evidence is cached, and binds its exact bytes into the inventory. Failed explicit re-verification changes an earlier success to uncertain, clears verification, preserves the recorded inventory and refuses viewing/undo; restoration of the exact original files still requires explicit verification. There is no automatic export retry.

These checks establish extracted-text agreement and correspondence between the PDF and stored renders. They do not certify all visible meaning, image-only claims, screenshot authenticity, readability or color fidelity. Human inspection remains required; visual sign-off is a separate local action and cannot certify synthetic output as native. MCP returns metadata, never PDF or image base64. Verified PDF/PNG viewing is local-only.

Undo only unlinks the recorded unchanged generated files, then removes their empty job directory. Modified/unrelated files, symlinks and source changes cause refusal. Original sources are never removed. A native deck may remain open after artifact removal; close it manually without saving deleted output back. Revoking blocks new jobs and access; a native export already started may complete its approved operations.

## Resource and filesystem limits

Source reads are bounded before allocation: 4 MiB per normal source, 32 MiB per template and 16 KiB for the manifest. XLSX extraction allows 32 parts, 8 MiB total and 6 MiB per part; candidate Keynote archives allow 1,024 parts, 64 MiB total and 16 MiB per part. Actual ZIP inflation lengths and CRCs are checked, rather than trusting declared sizes. PNGs must be noninterlaced RGB/RGBA, at most 1,600×1,200 and 1.92 million pixels; animations, unknown chunks and trailing compressed streams are rejected.

PDF inspection allows at most eight pages and 64 KiB of text/metadata; exports must have exactly three pages. Linux Poppler processes run with a 384 MiB address-space limit, 20/21-second CPU limits, 16 MiB file-size limit, 64 descriptors and Node time/output bounds. Rasterization emits one bounded PNG to stdout at a time; only the guarded application writer creates output files. The operation queue holds at most eight, preview reads use two slots with 24 waiting, and retained history is bounded to eight snapshots, 24 plans and 20 jobs without silently deleting evidence.

Paths must be canonical and remain inside the explicitly scoped root. Every ancestor is checked; source files must be regular, single-link files and are opened with no-follow and identity/change checks. Linux output writes use an already validated directory descriptor, fixed filenames and exclusive no-follow opens. The regression that replaces `Deliverables` with an external symlink at adapter entry now produces zero external files.

The OS user who owns the source, journal and folders remains trusted; these controls are not an OS security sandbox against that same user modifying their own process/files concurrently. In particular, Keynote receives pathname URLs in a separate process. Native guards detect observed directory/leaf changes, but cannot make the external app's save/export atomic against a concurrent same-user namespace mutation. Use a private, stable, reviewed demo folder on the Mac, stop on uncertainty, and retain this limitation during native acceptance. No security permission was broadened to conceal it.

## Prepare the actual Keynote template later

No Mac was contacted or woken. The bundled [Alder-review-seed.pptx](../fixtures/keynote-seed/Alder-review-seed.pptx) is a real three-slide OOXML seed, **not a `.key` file**. It opens and renders in Linux LibreOffice, including a filled-slot layout simulation; that does not establish Keynote compatibility. `npm run review:seed -- /empty/output/directory` explicitly recreates a seed without overwriting existing files.

When the user makes the Mac available and authorizes local setup:

1. Check out the exact reviewed commit, install the pinned Node dependencies and build the UI. Run `npm run macos:build` for the existing audio helper and `npm run macos:review:build` for the review helper. The latter generates `Keynote.h` using the installed `/Applications/Keynote.app` dictionary and compiles fixed Objective-C ScriptingBridge source. It pins source, dictionary and installed version/build; it launches no app or permission request. Compilation and current dictionary compatibility are still pending.
2. Stage the synthetic sources beside the explicitly selected local database with `FO_FIX_DATA=/exact/app-data/macos.sqlite npm run review:setup`. The parent data directory must exist or have an existing parent. Setup creates no permission lease.
3. Manually import the PPTX seed into Keynote, inspect it and save an actual single-file `.key` template. Alternatively prepare an equivalent reviewed native template with precisely the fixed slots below. Do not rename JSON, HTML or PPTX to `.key`.
4. Bind it explicitly: `npm run review:bind-native -- /exact/app-data/client-review /exact/approved/template.key`. This copies the candidate template with exclusive creation into `Creative/client-review.key`, updates its manifest hash and switches to native mode while retaining the synthetic data classification. ZIP `Index/*.iwa` structure is only a candidate check; opening and slot verification are still required. Keep the original template untouched.
5. Start `FO_FIX_DATA=/exact/app-data/macos.sqlite FO_FIX_REVIEW_ROOT=/exact/app-data/client-review npm run companion -- --review-native`. Grant the three displayed folders locally, inspect, preview and approve. Existing user-authorized Automation access must already permit this helper/host to control Keynote. The helper checks access without prompting; missing access fails closed. Stable helper identity/TCC behavior must be verified on the Mac rather than bypassed or reset silently.

The template must be 960×540 points with three unskipped slides, exactly four text items per slide, no shapes/tables/charts/groups/audio/movies, and no autoplay/loop/restart. The text markers are `FO_REVIEW_KICKER_n`, `FO_REVIEW_TITLE_n`, `FO_REVIEW_BODY_n`, `FO_REVIEW_FOOTER_n`; slide one's body starts with `5.5% gross conversion` and a newline before its marker. Kicker geometry is `(48,60,864,30)`, title `(48,96,864,76)`, footer `(48,504,864,22)`. Body is `(48,190,864,270)`, except slide two `(48,440,864,55)`. Slide two has exactly two 420×280 images at `(48,150)` and `(492,150)`, with descriptions `FO_REVIEW_BEFORE` and `FO_REVIEW_PROPOSED`. The seed uses cream backgrounds, green text and restrained amber. All types, markers and geometry are checked before edits; import mapping remains a Mac gate.

The fixed helper accepts only identity, read-only PDF inspection/rendering and its reviewed commit command. The read-only `pdf-render` command accepts only page 1, 2 or 3 of a bounded unencrypted three-page PDF and returns a bounded RGB PNG to stdout before any app or permission code. Rebuild the helper from this commit: the source/recipe hash changed, and an older helper cannot satisfy the new verification path. No generated AppleScript, JXA, shell, arbitrary selector or whole-Mac search runs. Before staging, the adapter checks the compiled recipe identity. The helper again checks the expected recipe and directory identities, hashes the staged template and images, copies only the template, fills validated fixed slots, saves the native copy, exports PDF, renders three RGB PNGs and leaves that edited copy open. Apple-event errors stop further operations. A physical receipt records source/dictionary/version and whether Keynote was initially stopped.

## Exact remaining native acceptance gates

- Compile against the actual installed Keynote dictionary, validate the real saved template's slot mapping/geometry and verify stable Automation authorization without permission broadening.
- Complete **five consecutive cold-start** copy/edit/save/export runs on that build. The user manually quits Keynote between runs after inspecting/saving as appropriate; the code never quits originals. Each run must check all three actual renders, approved screenshot content, correct PDF text/page count, unchanged original hashes and the editable copy left open. PDFKit RGB PNG compatibility must pass the same validator.
- Record local visual approval for each. `npm run review:native:audit -- 4310` reads and reverifies the latest five jobs and requires the current recipe/dictionary/version, cold-start receipts and visual approval. It never grants, executes, quits Keynote or assumes live Fo success.
- Exercise stale-source/template, permission denial/revocation and interrupted export through the real native path. Do not turn an uncertain job into an automatic retry.
- Complete **three consecutive actual Fo → authenticated relay → Mac → Fo runs**, including separately approved undo and observed user-visible results. SDK or cloud mocks cannot satisfy this gate. The audit deliberately leaves `liveFoReady` and `readyForLiveDemo` false without separately observed live evidence.

Production activation remains separately blocked on the user's private digest export, exact UTC deadline/configuration approval and authorized registration. No persistent credential, server/DNS/GCP setting, running deployment, access renewal or Fo account was changed in this source task. The deployment task must update its pinned payload to the final reviewed feature commit; pushing this branch does not deploy it.

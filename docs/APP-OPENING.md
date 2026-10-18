# Bounded app opening on macOS

Fo Reach can inspect and open Spotify, Music and Calculator through a separate native capability. Opening brings the approved app to the front. Playback, arbitrary apps, paths, URLs, shell commands and closing apps are outside this capability. There is no automatic close/undo because an app can contain unsaved work.

Build the fixed helper with `npm run macos:apps:build`. Start the local companion with `--macos-apps`; this can be combined with the explicit `--review-pptx` route. Use a normal logged-in macOS desktop session. The restricted development sandbox hides Launch Services and can make installed apps appear absent. No app is installed and no permission is granted at startup. Existing audio mode remains separate; `apps.inspect.source` identifies app evidence independently of `fo_fix_status.mode`.

The local **Open apps** page grants inspection of only the three supported apps for 20 minutes. Each opening needs a new exact five-minute proposal/digest approval. **Approve for Fo** records approval without opening. The agent then consumes it with `apps.open_approved`. The owner may alternatively use the local opening button. Revocation invalidates outstanding approvals. Restart does not restore consent or retry consumed operations. An OS launch already in progress cannot be cancelled; a consent change prevents a new post-launch inspection and leaves the result uncertain.

## MCP and device session

- `apps.inspect {}` returns three bounded installation/running facts and recent journal metadata after local consent.
- `apps.propose_open {"appId":"spotify"}` accepts only `spotify`, `music` or `calculator`; no launch occurs.
- `apps.open_approved {"id":"<plan UUID>"}` requires a matching, unexpired local approval and freshly matching signed app identity.

There is no MCP permission, approval, playback or undo tool. The native helper uses fixed arguments and NSWorkspace, with no scripts or shell. Spotify must meet its vendor signing requirement; Apple apps must meet their Apple signing requirement. The canonical bundle path and CDHash are approved. Before launch the helper rechecks the identity; after launch it also validates the running PID against that CDHash, so an older process at an updated bundle path cannot be accepted as the new version. No automatic restart/quit fixes a mismatch.

App opening is enabled independently in a session gateway using `FO_FIX_APPS_ENABLED=1`. The gateway must use the session backend; it cannot host native execution, grant inspection, or approve. Local companion setup must also enable apps. Strict request/result schemas reject arbitrary tools and fields. Delivered launch timeouts report `EXECUTION_UNCERTAIN` and direct the operator to the local journal; requests are never redelivered. This flag has not been deployed here, and no new credentials or Fo registration were created.

## Actual verification, 19 October2026

The installed bundle is `/Applications/Spotify (old).app`, version 1.3.4.258. Its name does not affect bundle-ID resolution. A real initial launch was verified while Spotify was previously stopped. After strengthening signature checks, two fresh complete local SDK/browser rehearsals (`dry-7`, `dry-8`) and a recorded normal-speed run (`capture-3`) passed. Each used a fresh synthetic review root, actual PPTX/PDF output, UI-only exact approval, real native app opening, running/frontmost verification and rejection of consumed approval replay. The final helper verifies both the installed and running code identities. No app was quit to manufacture repeated cold starts.

Final build passed; 166 unit/API/relay tests and 38 browser tests passed, with no skips. Two independent source rechecks found no remaining actionable issue after fixes. Synthetic test state is never counted as native proof. Native screenshot/accessibility inspection of Spotify timed out; the recorded coda shows the companion's real native confirmation, not a fabricated Spotify window. Playback, audibility, actual Fo voice input and actual Fo roundtrips remain unverified. Keynote acceptance remains unchanged from the prior audit.

Evidence is in the sibling `native-evidence/apps/` and `native-evidence/demo-takes/capture-3-output/`. The capture's job and app action are genuine; `realFo:false`, `voiceInput:false`, `playback:false` are explicit. All 12 original fixture/seed hashes and the imported native Keynote template hash remain unchanged. No merge, deployment, persistent credentials, recording submission or personal-file search occurred.

# Fo Reach

Fo Reach (formerly Fo Fix; internal compatibility identifiers are retained) provides personal-device troubleshooting through **Fo**, with a permission-controlled local MCP companion. Inspect actual state, explain one proposed change, obtain specific approval, execute, verify with a new read, and offer an approved undo.

This bounded MVP supports **sound-output selection and unmuting**. It does not inspect microphones, record audio, run arbitrary terminal commands, or change security or network settings. Sound output is the first adapter; the permission, proposal, journal, verification, and undo engine is reusable.

The optional **client-review workflow** reconciles ten synthetic files and previews a branded three-slide decision. The explicit Mac PPTX route creates a real editable deck and PDF; the Linux HTML/PDF route is a labelled simulation. Keynote native save/export acceptance failed. [Bounded owner phone review](docs/PHONE-REVIEW.md) is prepared with explicit Mac opt-in; live activation, physical-phone acceptance and complete Fo runs remain unpassed. See [the demo and native handoff](docs/CLIENT-REVIEW.md) and [implementation/test evidence](docs/CLIENT-REVIEW-VERIFICATION.md). Run the synthetic route with `npm run build` followed by `npm run review:demo` after installing its documented prerequisites.

**The cloud fixture is synthetic. No real device has been repaired.** Authenticated remote fixture/session profiles are implemented and tested with synthetic identities and devices; actual hosting, Fo registration and macOS hardware validation remain incomplete. The existing Fo account connector is a separate integration, not a connection to this companion.

The selected hostname is `fo-reach.latchgrid.in`. The parent reports server and DNS infrastructure prepared separately; app activation remains pending approved credential configuration and reviewed source deployment. This source task changes neither GCP nor DNS. See [current client-review evidence](docs/CLIENT-REVIEW-VERIFICATION.md); the [version 4 review](docs/REVIEW-2026-10-18.md) records the earlier audio baseline.

## Run in this cloud workspace

Requires Node.js 24.5+ and npm (verified on 24.19). The default local fixture needs no account, API key, paid model or hardware. The explicit remote bearer profile needs separate approved MCP/owner credentials; an external OAuth provider is optional.

```bash
cd /workspace/wajo-hack
npm ci --cache /tmp/fo-fix-npm-cache
npm run build
node --import tsx src/server/main.ts --production
```

Open `http://127.0.0.1:4310` **inside this environment**. Local mode deliberately binds only to loopback and rejects foreign Host and Origin headers. This command does not publish a public service. If your cloud environment provides a preview, it must preserve the loopback host and same-origin browser behavior; this build does not assume any provider-specific preview route.

`npm start` is an equivalent convenience command. For a cloud process runner, launch the Node command directly so its stop signal targets the companion rather than only an npm/loader wrapper. The long-running scripts use `node --import tsx`; the loader is a runtime dependency.

For development use `npm run dev` (Vite served by the same backend; refresh after changes). For a separate port: `FO_FIX_PORT=4312 npm start`. For an ephemeral test store: `FO_FIX_DATA=:memory: npm start`.

The app stores fixture state, proposals, action history, and activity in `.fo-fix/fixture.sqlite` (ignored by Git). The directory is created with mode 0700 and the database with mode 0600. One process holds an exclusive SQLite lock to prevent multiple writers replaying the same approvals. Stop the app before accessing its database with another process. To reset **synthetic demo data**, stop the app and remove that database, then restart. Do not delete a real-device journal as a repair procedure.

## Credentials and Fo-controlled execution

The [narrow recovery review](docs/RECOVERY-REVIEW.md) records the reviewed source baseline, captured stale-poll regression and current cloud checks. File/form demo extensions are outside that review.

Download the self-contained [offline credential helper](tools/offline-credentials.html) and follow the [user-controlled handoff](docs/CREDENTIAL-HANDOFF.md). It generates nothing until an explicit click, exports only digests, and creates no server endpoint or configuration. No real user credentials were generated during development.

When Fo proposes a repair or undo, review it in the owner/local companion interface and choose **Approve for Fo**. That records approval without executing; Fo then executes the exact approved plan through MCP. The waiting state permits Decline and survives reload. **Approve & apply** remains the manual alternative. Remote bearer owners see their session and deployment deadlines in UTC. Account registration remains managed in Wajo; service status cannot prove it.

## Try the full flow

1. Allow a 20-minute sound-output inspection. The lease also lets connected MCP clients read locally recorded repair evidence; it never authorizes a change.
2. The synthetic fixture initially routes sound to Studio Display. Select MacBook Speakers and review the exact proposed change.
3. Read the effect and risk, check the specific-approval box, and approve. The backend consumes approval before invoking the adapter.
4. A fresh read verifies the **setting**. The app labels the result as simulated; it cannot verify human audibility.
5. Open Action history → Review undo. Undo is a new plan and requires its own approval. If state has changed, undo refuses to overwrite a newer choice.
6. To try unmuting, switch to the fixture's muted Desk Headphones, then choose Output is muted and review an unmute repair. Output selection never silently changes mute or volume.
7. Permissions → Revoke device access cancels outstanding plans and blocks new device reads/writes. An already-started write finishes its bounded verification and journal record. Restart or replacing a lease invalidates all pending/approved plans. Every write also retires other outstanding authorizations, even if state later returns to the same values.

## Real macOS companion (source provided; not hardware-verified)

On the Mac, with Node.js 24+ and the Xcode Command Line Tools already available:

```bash
npm ci
npm run build
npm run macos:build
npm run companion
```

The native Swift helper uses CoreAudio to enumerate output devices, read the default output and supported mute controls, set the default output, or set that device's mute state. Devices without a supported settable main-channel mute control are clearly unsupported. It uses `execFile` with a fixed helper path and enumerated arguments, never a shell or `sudo`. Starting the companion does not install a daemon, create credentials, request microphone permission, or register persistent access.

Real state lives separately in `.fo-fix/macos.sqlite`. Failure to start or read real hardware does **not** silently fall back to fixture mode. Build errors, macOS behavior, permissions, and physical audibility still need a Mac validation pass. The default output may not affect apps that keep their own output choice. CoreAudio device IDs can change after restart/disconnection, which should invalidate stale plans.

## Authenticated remote mode and separate device sessions

For the selected GCP path, see [dedicated VM preparation](docs/GCP-VM.md): one supervised Node process, local Caddy HTTPS and a mount-guarded persistent SQLite disk. Its templates and offline checks create no cloud resources or real credentials; live GCP/Caddy/TLS acceptance remains pending.

See [deployment and authentication](docs/DEPLOYMENT.md) for complete instructions and safe blank [server](deploy/remote.env.example), [companion](deploy/companion.env.example) and [TLS proxy](deploy/nginx.conf.example) templates. No template creates credentials or deploys anything.

The bounded hackathon path is `FO_FIX_AUTH_MODE=bearer`: independent MCP and owner credentials, configured only as SHA-256 digests, with a deployment deadline within 24 hours. The owner uses a masked HTTPS form to establish a 15-minute Secure HttpOnly session with CSRF protection. MCP credentials cannot sign in as owner or authenticate owner APIs. No real credentials are generated by this project. The retained external OAuth profile is optional and its live Fo compatibility is unverified; merely supplying an issuer URL is insufficient.

For conventional hosting, explicitly select a private `0.0.0.0` listener and an exact allowlist of verified TLS-proxy socket addresses; `PORT` is accepted from the host. The default remains loopback with a same-host TLS proxy. Both profiles retain exact Host/Origin/HTTPS validation. See the [host checklist](deploy/host.env.example); actual provider routing must be confirmed before purchase/deployment. One long-running process/replica and a private persistent fixture volume are supported; no WebSockets or persistent SSE are needed.

Fo's current catalogue, independently read by the parent, advertises `build_mcp_server` with `serverName`, `url`, `transport: "streamable_http"`, `auth: "bearer"`, `scope: "personal"`. Only after authorized registration does the user enter the MCP credential through Fo's credential form as `{token}`; never include it in the registration arguments. Keep the owner credential private. This is prepared code with synthetic tests, not a live deployed or Fo-connected service.
A remote fixture colocates its synthetic engine with the cloud service. A real device session instead leaves the engine and journal on the Mac, and runs `npm run companion:connect` manually as a separate outbound process with a previously authorized token. Sessions expire within 3 hours and never automatically reconnect. Machine requests use strict MCP operations and cannot grant or approve. The optional [owner phone-review path](docs/PHONE-REVIEW.md) supports review approval and fixed previews only after separate local opt-in; it cannot grant or renew file access or approve audio/app changes. Offline devices produce an unavailable status. This cloud cannot read a Mac merely because the code is hosted here.

`npm run diagnostics` checks configuration and credential presence without showing values or making network/model calls. `npm run diagnostics:network` adds fixed unauthenticated connectivity probes through the configured environment proxy. The current task reports a missing Claude credential and denied network. No paid call runs automatically.

## MCP interface

The running companion serves MCP Streamable HTTP at `http://127.0.0.1:4310/mcp`. It also supports a stdio bridge which forwards to the **same running process**, so the web UI and agent share one approval engine and journal:

```bash
npm run mcp
```

For a generic local MCP client, use the direct command `node --import tsx /absolute/path/to/fo-fix/src/server/stdio.ts` with `cwd` set to the project and `FO_FIX_PORT` matching the companion. This is a standard MCP client configuration hint, **not a verified Fo registration recipe**.

| Tool                      | Purpose                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `fo_fix_status`           | Mode, permission status and history counts; plan/history details require an active lease |
| `fo_fix_inspect_output`   | Fresh read within the temporary permission lease                                         |
| `fo_fix_propose_repair`   | Create one `switch-output` or `unmute-output` proposal                                   |
| `fo_fix_execute_approved` | Consume and execute an exact, unexpired, human-approved plan                             |
| `fo_fix_propose_undo`     | Create a new inverse proposal for a verified repair                                      |

There is **no MCP tool to grant permission or approve a plan**. Those actions require the human-review interface; device sessions accept them only in the local companion interface. Calling execute with an unapproved, denied, expired, stale, or consumed plan fails closed. All tool schemas reject extra arguments.

Declining a proposal takes effect immediately during its pre-write read; it does not wait behind the execution queue. Once an OS write has started, it cannot be cancelled. Shutdown blocks new work and keeps the database lock until active writes have finished verification and recording. Agent-facing status withholds historical device details after lease expiry/revocation; the local human history remains available. The stdio bridge preserves the same safety instructions and tool contracts as HTTP. A connected client's execution also updates the open browser through status polling.

Fo should inspect only after local consent, explain the returned proposal faithfully, direct the person to the local review interface, execute only after that approval, and describe verification using the returned evidence. Fixture data must always be described as synthetic. See [Fo integration research](docs/FO-INTEGRATION.md) for what is verified and what remains blocked.

## Tests and evidence

```bash
npm run build        # TypeScript check and production bundle
npm test             # engine, bearer/OAuth/CSRF, proxy, MCP, relay and lifecycle tests
npm run test:e2e     # real Chromium browser flow, mobile and accessibility checks
npm run check        # all of the above
```

`npm run test:haiku` is a separate, opt-in live API smoke test authorized for this task. It requires an `ANTHROPIC_API_KEY` already provided through the platform environment, checks the current Haiku ID against the account's official model listing, and makes at most one 16-output-token request with a fixed nonprivate prompt. It does not load `.env` files, expose secrets, or run as part of ordinary tests. In this running task it reports **blocked: credential unavailable** and makes no request. See the verification report for details.

Playwright uses `/usr/bin/chromium` if present. Else run `npx playwright install chromium` in an environment allowing that download. `CHROMIUM_PATH` selects another existing executable. The cloud's browser-download domain was blocked, so the tests here use its preinstalled Chromium. The browser test companion has an in-memory synthetic store and a separate port (4318); it never changes the running demo's journal.

Actual results, initial failures and fixes, native limitations, and the separate Claude API availability check are in [verification evidence](docs/VERIFICATION.md). [Security review](docs/SECURITY-REVIEW.md) records the follow-up review and regression coverage. Synthetic browser captures remain under `docs/screenshots/` in the original cloud workspace; browser screenshots are excluded from the private source archive.

## Code map and boundaries

| Location                            | Responsibility                                                                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/core/engine.ts`                | Leases, immutable proposals, exact approvals, serialized execution, journal, fresh-read verification, conditional undo |
| `src/core/store.ts`                 | Durable single-writer SQLite state, private local file modes                                                           |
| `src/companion/adapter.ts`          | Shared adapter contract, explicitly synthetic fixture and fixed-executable macOS adapter                               |
| `companion/macos/AudioHelper.swift` | Narrow native CoreAudio operations                                                                                     |
| `src/server/`                       | Validated API, human-only approval routes, MCP HTTP and stdio bridge                                                   |
| `src/web/`                          | Responsive troubleshooting, approval dialog, history, permissions, connection status                                   |
| `tests/`                            | Safety behavior, failures, persistence, protocol and browser coverage                                                  |

Local mode trusts the OS user and other processes under that user; Host/Origin checks are not authentication against another local process. The owner-writable journal is durable, not tamper-proof. Remote mode adds explicit bearer or optional external OAuth authentication and a bounded outbound device session with separate authority; deployment/account configuration is mandatory and no live service or Fo registration is claimed. There is no background/autostart agent, persistent pairing or external telemetry. Data is sent only for explicit authenticated tool requests within local consent; the engine does not call a model. The two existing repairs and the setting-versus-audibility limits remain unchanged.

To add an adapter, preserve the exact-approval, stale-state, single-use, write-ahead journal, verification, and inverse-plan rules. Add only enumerated setting changes with meaningful preconditions; do not introduce general command execution.

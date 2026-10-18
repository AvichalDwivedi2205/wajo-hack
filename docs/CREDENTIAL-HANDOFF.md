# User-controlled credential handoff

Fo Reach uses independent owner and MCP credentials. Fo receives only the MCP credential and cannot approve repairs. This procedure does not authorize generation, configuration, an access extension or native pairing by itself. Obtain the user's specific approval at the action being taken.

## Generate privately, on an explicit click

Download [tools/offline-credentials.html](../tools/offline-credentials.html) from the pinned source revision, save it as an HTML file and open that downloaded file in a current browser. It is one self-contained file; it is not a server setup page. No credential is generated on opening it. No account, server setting or permission is changed by the helper.

When ready, the user chooses **Generate owner and MCP credentials now**. The helper uses two separate Web Crypto calls, each requesting 32 random bytes, and encodes them as 43-character unpadded base64url strings. It displays masked values and computes SHA-256 over each exact UTF-8 credential string, without adding a newline or decoding the string first. The server requires this exact format; ordinary padded base64 is different.

Save each plaintext credential as a separate entry in the user's own vault. The owner credential is only for the approved Fo Reach sign-in form; the MCP credential is only for Fo's secure credential form. Do not send the owner credential, owner cookie or authenticated owner browser session to Fo. Do not paste plaintext credentials into chat, shell commands, screenshots, recordings or support logs.

After confirming both values are saved, **Download digests only** exports just `FO_FIX_OWNER_TOKEN_SHA256` and `FO_FIX_MCP_TOKEN_SHA256`. No plaintext credential is exported. The helper has no network calls, analytics, external resources, browser persistence, cookies, clipboard automation or server-configuration API. CSP pins its inline source and blocks network connections, workers and form submission. Hide/blur masks values; Clear or pagehide removes displayed values and invalidates in-flight generation. A digest cannot recover a lost credential. Browser extensions, clipboard history and the user's vault remain under the user's control.

## Review the exact installation before authorizing it

Prepare a concrete review containing the actual two exported digests, approved HTTPS origin, backend, exact UTC deadline and service restart. For example, ask for authorization to:

> Configure the reviewed owner and MCP digests for `https://fo-reach.latchgrid.in`, using the explicitly labelled fixture backend, until **[exact UTC timestamp]**, and restart the single Fo Reach service. No automatic renewal or native-device pairing is included.

Substitute the agreed timestamp and display the actual digests before approval. `FO_FIX_ACCESS_EXPIRES_AT` must be a future UTC ISO value within the next 24 hours at service startup. Owner sessions last at most 15 minutes and never exceed that deadline. Expiry rejects authenticated requests; no background renewal occurs. Renewal/rotation requires a separately approved configuration change and restart. Restart clears owner sessions and invalidates permissions/approvals in a colocated fixture engine. A gateway restart ends its device session; local Mac permission and approval remain governed by the Mac companion and its own expiry or local revocation.

Through the already approved administration channel, install only the digests and non-secret configuration into the root-owned mode-0600 `/etc/fo-fix/fo-fix.env`, following [the GCP template](../deploy/gcp/fo-fix.env.example). Keep credentials out of VM metadata, startup scripts, Git, command arguments and request/debug logs. No unauthenticated setup endpoint is required. Configuration checks reject incomplete values, identical role digests or an invalid deadline before listening.

Only digests are stored as deployment configuration. During normal authentication the TLS terminator and server necessarily receive plaintext in memory: the owner's login POST and Fo's MCP Authorization header. The application does not log them; deployment logging/tracing must also avoid headers, cookies and bodies. This is not a claim that the server never handles plaintext.

## Fo registration and execution

Use the approved personal registration with `serverName: "Fo Reach"`, URL `https://fo-reach.latchgrid.in/mcp`, `transport: "streamable_http"`, `auth: "bearer"`, and `scope: "personal"`. Enter the MCP plaintext personally into Fo's subsequent `{token}` credential form; never put it in a registration tool argument. See [catalogue evidence and live acceptance limits](FO-INTEGRATION.md).

Sign into the separate Fo Reach owner form with the owner plaintext. Allow inspection, then ask Fo to inspect and propose one repair. Review the exact effect/risk and choose **Approve for Fo**. That path approves without executing. It displays an approved/waiting state; Fo must call `fo_fix_execute_approved` with the same plan ID before expiry. Decline revokes the approval. **Approve & apply** remains an explicit manual alternative. Undo is a new proposal requiring another specific human approval. Never share an authenticated owner browser with the orchestrator.

Test a live Fo call, rejection before approval, approval-only execution, fresh-read verification and separately approved undo. A synthetic fixture result is evidence of integration with simulated state; it is not an actual device repair. `fo.connected` is null because this service cannot verify Wajo account registration. The interface directs the user to observed live tool results rather than inventing account state.

## Native companion later

Real-device pairing needs a separate approval, a third independently generated credential, its configured `FO_FIX_COMPANION_TOKEN_SHA256`, a fixed non-secret device ID, and `FO_FIX_BACKEND=session`. Keep its plaintext only with the user and foreground Mac companion. The current launcher reads `FO_FIX_COMPANION_ACCESS_TOKEN` from its environment; provision that locally through an approved hidden-input/private handoff, never a pasted command-line value. This helper deliberately generates only owner/MCP credentials.

The Mac connects outbound manually for at most 20 minutes or the deployment deadline. Its local interface grants inspection and approves each change; cloud owner routes cannot do either. There is no automatic reconnect, daemon installation or silent fallback to fixtures. macOS compilation, hardware behavior, physical audibility and actual live Fo acceptance remain unverified until those checks are performed.

## Maintaining the helper

After editing/formatting its HTML, run `node scripts/pin-credential-helper.mjs --write` to update the two static CSP hashes. This hashes source code only and creates no credentials. Run `npm run check`. Helper browser tests replace randomness with deterministic synthetic bytes, disable screenshots/traces/video, assert digest-only downloads and check for network/storage activity. Managed cloud Chromium blocks `file://`, so the browser tests fulfill the exact file in memory at a loopback document URL; this does not add an application endpoint or change browser security policy. Direct downloaded-file use still needs validation in the user's browser.

# Fo integration evidence — 2026-10-18

Fo is the actual target. The existing Fo connector in ChatGPT is separate from this custom MCP connection. **No real registration, credentials, public deployment or live Fo invocation has occurred.** Successful repairs and identity tests are synthetic.

## Current official catalogue evidence

The parent independently retrieved read-only `tools/list` from the official `https://mcp.wajo.ai/mcp`. This cloud's own browser and shell attempts remain proxy-denied; do not describe the parent's evidence as a successful cloud retrieval.

The confirmed `build_mcp_server` schema requires `serverName` and `url`. The bounded request sets `transport: "streamable_http"`, `auth: "bearer"`, `scope: "personal"` explicitly. Organization is the scope default. Optional `secretName` selects a per-user credential-store key; its default derives from the server name. The credential bag is `{token}`, supplied through Fo/Wajo's credential form **after registration**, not a registration-tool argument.

The catalogue advertises bearer, Basic, OAuth and none. The chosen bearer mode has no `oauthProviderId` requirement. OAuth instead requires an operator-curated `oauthProviderId`, or Dynamic Client Registration when that field is empty; an issuer URL alone is insufficient. No matching curated provider or Fo-compatible DCR is available here. The earlier mandatory custom OAuth contract was an unjustified integration assumption and is now optional.

The October 17 authorized Mac preparation also observed `mcp_call` and the manual [Connections](https://wajo.ai/user/connections?status=all) → Add MCP → Enter manually flow. [Official support](https://wajo.ai/support) and the [agent documentation index](https://wajo.ai/llms.txt) loaded earlier, while linked catalogue/docs pages could not be retrieved here. None of this establishes live invocation of our service or builder-hosted deployment.

## Implemented contract and authority separation

Fo Reach exposes five strict tools through the official MCP SDK. No grants, approvals, terminal command or arbitrary URL exists in the tool set. Its explicit single-owner bearer profile verifies a configured MCP credential digest on every request. A distinct owner credential creates a Secure HttpOnly short-lived browser session with CSRF protection; the MCP credential cannot sign in as owner or use owner APIs. Device-session mode uses a third independent companion credential and retains inspection/approval on the local device.

The service accepts stateless Streamable HTTP POST with JSON results. The bearer profile is explicit configuration, not a claimed OAuth discovery implementation. It advertises no invented authorization server; optional OAuth remains separately selected. SDK tests exercise the full fixture flow and separate device relay under both modes; those tests do not establish live Fo compatibility.

The owner/local companion now offers **Approve for Fo** for repairs and undo. It records exact approval without executing. Fo executes through its existing bounded MCP tool. Owner deadline display and the offline credential handoff are documented in [CREDENTIAL-HANDOFF.md](CREDENTIAL-HANDOFF.md). `fo.connected` is null: account state is unknown to this service and must be checked through actual Wajo registration and live results.

## Exact remaining authorized acceptance

1. Confirm an approved HTTPS origin/host, actual trusted proxy source addresses or same-host TLS arrangement, and one persistent fixture volume. No hosting purchase should be based on unverified routing assumptions.
2. Obtain explicit authorization to create/provision unique MCP and owner credentials and a deadline, plus a third companion credential only for session mode. The server stores digests; only Fo's credential form receives the MCP plaintext. The owner plaintext stays with the owner. No real values were created here.
3. Obtain explicit authorization for the personal-scope custom registration. Use exactly the approved name/URL and the confirmed fields above; enter `{token}` through the subsequent secure form. The current code does not perform this handoff or account mutation.
4. Run a live Fo fixture acceptance: consent, inspection, proposal, rejection before approval, separate owner approval, execution, verified synthetic source/history, undo proposal, new approval and verified restoration. Then repeat through a separate fixture companion before any hardware test.
5. Compile and validate the native helper on macOS with real hardware and human audibility checks. The cloud cannot inspect or repair an offline Mac.

[DEPLOYMENT.md](DEPLOYMENT.md) has minimal configuration, credential boundaries, hosting limits and optional OAuth details. Until actual hosting and Fo acceptance pass, describe this as integration preparation with tested synthetic code.

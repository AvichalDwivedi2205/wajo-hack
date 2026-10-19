# Fo integration evidence

Fo is the actual target. The existing Fo connector in Codex is separate from this repository's custom MCP connection.

## Current acceptance snapshot — 2026-10-19

The existing GCP application is activated; unauthenticated MCP GET/POST return401 with normal TLS. Personal Fo registration and private MCP credential entry are complete. The foreground Mac companion connected with a three-hour maximum session. Actual Fo calls completed `review.snapshot`, `review.prepare`, `review.commit` and `review.verify`, producing a real editable PPTX and three-page PDF on this Mac. The first proposal expired before approval; a fresh equivalent proposal was explicitly approved and committed. Codex checked all three rendered pages and applied the human's exact approval through the local Mac owner UI. Physical-phone approval remains unverified. The first attachment transfer was truncated inside Fo; no email or call was sent. **Zero complete presentation → delivered email → completed call runs have passed.** Owner/MCP/companion plaintext remains private; only their digests are installed. The download fix below is implemented and still awaits deployed live acceptance.

Fo's inspected runtime registration contract uses `server_name`, `url`, `transport` and `auth`; personal user scope is implicit, with no scope input. Use the runtime's actual contract when registering the approved name **Fo Reach**, URL `https://fo-reach.latchgrid.in/mcp`, transport `streamable_http` and auth `bearer`. It returns a `connect_url` for the user to enter the MCP token privately. Never put the token in chat or a tool argument. The camel-case public catalogue schema recorded below is historical evidence, not the schema for the current runtime tool.

Fo reports native email attachment inputs `attachment_artifact_ids` / `attachment_file_ref_ids`, at most ten files and 6 MiB total; raw base64 and URLs are not attachment inputs. Actual Fo creation and verification passed for one synthetic-data deck, but its first 64 KiB base64 read was truncated by Fo's tool-result budget. No email or call followed. The session gateway's `review.attachment_download` instead gives Fo a private, single-use URL for one already approved file, lasting at most two minutes. Fo must GET it directly in its coding workspace, verify complete original SHA-256, and obtain the workspace's actual attachment artifact reference. Never paste capability URLs into logs, chat summaries or published traces. URLs are not native email attachment inputs. The Mac rechecks sharing, session and file hashes before any HTTP bytes leave. Live acceptance of this new transfer remains required. Fo also reports native calling with an AI/recording notice. Neither actual attachment delivery nor a demo call has passed acceptance.

See [GCP-VM.md](GCP-VM.md) for the current deployment snapshot and [PHONE-REVIEW.md](PHONE-REVIEW.md) for the implemented, still unverified live phone approval path. Reuse existing authorizations for exact activation and registration; the historical checklist below is not a request for repeated consent.

## Historical official catalogue evidence — 2026-10-18

The parent independently retrieved read-only `tools/list` from the official `https://mcp.wajo.ai/mcp`. This cloud's own browser and shell attempts remain proxy-denied; do not describe the parent's evidence as a successful cloud retrieval.

The confirmed `build_mcp_server` schema requires `serverName` and `url`. The bounded request sets `transport: "streamable_http"`, `auth: "bearer"`, `scope: "personal"` explicitly. Organization is the scope default. Optional `secretName` selects a per-user credential-store key; its default derives from the server name. The credential bag is `{token}`, supplied through Fo/Wajo's credential form **after registration**, not a registration-tool argument.

The catalogue advertises bearer, Basic, OAuth and none. The chosen bearer mode has no `oauthProviderId` requirement. OAuth instead requires an operator-curated `oauthProviderId`, or Dynamic Client Registration when that field is empty; an issuer URL alone is insufficient. No matching curated provider or Fo-compatible DCR is available here. The earlier mandatory custom OAuth contract was an unjustified integration assumption and is now optional.

The October 17 authorized Mac preparation also observed `mcp_call` and the manual [Connections](https://wajo.ai/user/connections?status=all) → Add MCP → Enter manually flow. [Official support](https://wajo.ai/support) and the [agent documentation index](https://wajo.ai/llms.txt) loaded earlier, while linked catalogue/docs pages could not be retrieved here. None of this establishes live invocation of our service or builder-hosted deployment.

## Implemented contract and authority separation

Fo Reach exposes five strict repair tools, plus separately enabled app tools, six Mac review tools and one session-gateway attachment download tool through the official MCP SDK. No grants, approvals, terminal command or arbitrary URL exists in the MCP tool set. Its explicit single-owner bearer profile verifies a configured MCP credential digest on every request. A distinct owner credential creates a Secure HttpOnly short-lived browser session with CSRF protection; the MCP credential cannot sign in as owner or use owner APIs. Device-session mode uses a third independent companion credential. Folder consent remains Mac-only; exact owner phone decisions can be relayed only after explicit local opt-in for the current file lease and connection. Fo cannot approve.

The service accepts stateless Streamable HTTP POST with JSON results. The bearer profile is explicit configuration, not a claimed OAuth discovery implementation. It advertises no invented authorization server; optional OAuth remains separately selected. SDK tests exercise the full fixture flow and separate device relay under both modes; those tests do not establish live Fo compatibility.

The owner/local companion now offers **Approve for Fo** for repairs and undo. It records exact approval without executing. Fo executes through its existing bounded MCP tool. Owner deadline display and the offline credential handoff are documented in [CREDENTIAL-HANDOFF.md](CREDENTIAL-HANDOFF.md). `fo.connected` is null: account state is unknown to this service and must be checked through actual Wajo registration and live results.

## Historical preparation checklist and remaining acceptance

Steps 1–3 have since received the current exact authorization described above; credential generation and resource provisioning have occurred. Activation and actual personal registration now have verified receipts. Private token entry, Mac connection and live acceptance remain pending. Do not repeat completed resource creation or authorization prompts.

1. Confirm an approved HTTPS origin/host, actual trusted proxy source addresses or same-host TLS arrangement, and one persistent fixture volume. No hosting purchase should be based on unverified routing assumptions.
2. Obtain explicit authorization to create/provision unique MCP and owner credentials and a deadline, plus a third companion credential only for session mode. The server stores digests; only Fo's credential form receives the MCP plaintext. The owner plaintext stays with the owner. No real values were created here.
3. Obtain explicit authorization for the personal-scope custom registration. Use exactly the approved name/URL and the confirmed fields above; enter `{token}` through the subsequent secure form. The current code does not perform this handoff or account mutation.
4. Run a live Fo fixture acceptance: consent, inspection, proposal, rejection before approval, separate owner approval, execution, verified synthetic source/history, undo proposal, new approval and verified restoration. Then repeat through a separate fixture companion before any hardware test.
5. Compile and validate the native helper on macOS with real hardware and human audibility checks. The cloud cannot inspect or repair an offline Mac.

[DEPLOYMENT.md](DEPLOYMENT.md) has minimal configuration, credential boundaries, hosting limits and optional OAuth details. Until actual hosting and Fo acceptance pass, describe this as integration preparation with tested synthetic code.

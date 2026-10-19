# Dedicated GCP VM: status and provisioning runbook

## Current deployment snapshot — 2026-10-19 11:40 IST

The original preparation-only description below is historical. An existing dedicated VM, hostname and public TLS are now provisioned through the deployment chat **Verify dedicated deployment project** (`01a14d9c-09e4-7060-9dda-b61cfd7b8025`). Reuse that deployment; do not create another VM or repeat its resource approvals.

- VM `fo-reach-vm-261018`, ID `3011348200142002901`, is running at `35.209.26.89`. Its API-verified automatic STOP is **2026-10-19T18:15:00Z / 23:45 IST today**; automatic restart is disabled.
- `https://fo-reach.latchgrid.in/offline-credentials.html` returns 200 with normal public TLS. Application routing is active: unauthenticated MCP GET/POST return **401**, requiring the configured credential.
- The user privately generated separate owner, MCP and companion credentials and supplied their digests. Plaintext values are not in this repository or deployment handoff.
- Exact source `19b86db0f0bf3f4c5c61bbda942a4c0624400364`, session backend, device `fo-reach-demo-mac-20261019`, expiry above, existing-service/VM restart and personal Fo registration are approved. Application activation and VM/service restart checks passed at 06:08:04 UTC / 11:38 IST in the existing deployment chat. Installed canonical environment SHA-256 is `b3d39586b501659e65f5f6353e8e46ae6bc6209a9b5200945e56bfae5f37ddf5`, root-owned0600; startup SHA-256 is `5e2b3ffec6dbacf12ea7c4008d63d2f4a2205a849a9301e4af9f0e170f9a623c`.
- Preserve the retained 20 GiB disk, existing TCP443-only public ingress, no runtime service account and USD100 ceiling. New resources or broader access are outside this activation scope.
- Actual Fo personal registration succeeded after the earlier initialize404 failure. Private MCP-token entry, a connected Mac session and genuine Fo end-to-end acceptance remain pending. **Zero complete live runs have passed.** A helper-page response or engineering test is not a demo success.

## Historical/new-environment provisioning runbook

The remaining numbered steps describe how a new deployment must be prepared. They are not evidence that the current environment lacks resources, and they do not require repeating approvals already supplied for the exact existing deployment. Scripts in this repository do not themselves provision resources or generate credentials.

Use one dedicated Compute Engine Linux VM with systemd, Node **24.19.0**, one Fo Fix process, local Caddy TLS termination, and a separate persistent data disk. Caddy forwards to `127.0.0.1:4310`; port 4310 and Caddy's default loopback admin endpoint must remain private. No load balancer, cluster, managed database, runtime GCP API permission or external OAuth platform is needed. The original capacity/pricing discussion was preparation only; the current bounded resource approval is recorded above.

## 1. Read-only preflight — existing authorized operator environment

Fill the [review worksheet](../deploy/gcp/deployment-plan.env.example); it is not executable. These commands inspect access only, using an already installed/authenticated CLI. They do not log in or configure credentials:

```bash
fofix_project='REPLACE_PROJECT'
gcloud auth list --filter='status:ACTIVE' --format='value(account)'
gcloud projects describe "$fofix_project" --format='value(projectId,lifecycleState)'
gcloud services list --enabled --project="$fofix_project" \
  --filter='config.name=compute.googleapis.com' --format='value(config.name)'
gcloud billing projects describe "$fofix_project" --format='value(billingEnabled)'
```

Missing permission, billing, API access or SDK is a blocker to report, not permission to enable/change it. Do not print access tokens, credential files, service-account keys or full environment/configuration dumps. Confirm the intended region/zone, existing network/subnet and ownership of the DNS hostname through read-only views. Account/project selection must be explicit on later resource commands; do not rely on hidden CLI defaults.

## 2. Approval gate — resources, access, disk and TLS

Before any external mutation, approve the exact project, region/zone, VM name/image/machine type, disk type/capacity/retention, static IP, existing network/subnet, spending ceiling and teardown deadline. Separately approve the administration route, required API changes (if any), target-specific ingress for TCP 80/443, DNS updates, TLS issuer/terms/account-key creation and credential provisioning. No broad IAM grant, public SSH rule, runtime service-account credential, new network, or firewall opening for 4310/2019 is implied. The app does not need a GCP service account; do not attach permissions merely for the app to run.

Only after those approvals may an authorized operator create/attach the named VM, address and disk, configure the approved ingress/DNS, install the reviewed Node/Caddy versions and create the dedicated unprivileged OS account `fofix`. There is deliberately no one-command provisioner or embedded credential-generation step here. Keep Caddy and Fo Fix stopped until configuration is reviewed.

Inspect the selected disk with `lsblk -f`/`blkid`. Mount it at `/var/lib/fo-fix`; use the verified filesystem UUID in [fstab.example](../deploy/gcp/fstab.example). Formatting is destructive and requires explicit approval for a verified new blank disk; never format an existing data disk or blindly append fstab entries. Google documents [disk identification, formatting and persistent mounting](https://docs.cloud.google.com/compute/docs/disks/format-mount-disk-linux). Set the mounted directory owner to `fofix`, mode 0700; SQLite creates its file as 0600 and needs its rollback journal in the same directory. Retain the disk independently of VM deletion unless deletion is specifically approved.

## 3. Approval gate — install reviewed configuration

| Template                                               | Approved VM destination / requirement                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [fo-fix.env.example](../deploy/gcp/fo-fix.env.example) | `/etc/fo-fix/fo-fix.env`, root-owned 0600; fill origin, separate digests and deadline                             |
| [fo-fix.service](../deploy/gcp/fo-fix.service)         | `/etc/systemd/system/fo-fix.service`; source/built bundle at `/opt/fo-fix`, Node at `/opt/node-v24.19.0/bin/node` |
| [Caddyfile.example](../deploy/gcp/Caddyfile.example)   | `/etc/caddy/Caddyfile`; replace only `REPLACE_HOSTNAME` with the approved hostname                                |

Build with the pinned lockfile before activation: `npm ci` then `npm run build`; a production-only runtime install is supported. Keep source/runtime files root-owned and readable by `fofix`; writable application data stays on the mounted disk. The unit supervises Node directly, signals graceful shutdown, limits restart attempts and refuses startup if the data directory is not a mount point. It does not mount, format or create the disk. Use the package's official Caddy systemd service rather than a second custom supervisor. Caddy's [service guide](https://caddyserver.com/docs/running) identifies its separate `/var/lib/caddy` certificate/configuration state; preserve that private state across restarts and plan any backup separately from the app journal.

Use unique independently approved random MCP and owner credentials, at least 32 random bytes encoded base64url. Only their SHA-256 digests go in the app environment, with an absolute UTC access deadline within 24 hours. No plaintext belongs in command arguments, source, logs or VM metadata/startup scripts. Enter the owner credential only into the masked HTTPS owner form. After separately authorized personal Fo registration, enter only the MCP credential into Fo's subsequent `{token}` credential form. The MCP credential can never approve; owner access uses a 15-minute Secure HttpOnly cookie and same-origin/CSRF checks. Do not copy offline test credentials. Details: [deployment contract](DEPLOYMENT.md), [exact Fo fields](FO-INTEGRATION.md).

Caddy preserves Host/Origin, removes incoming forwarding context, sets upstream `X-Forwarded-Proto: https`, disables retries and flushes responses promptly. Its [reverse-proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) describes these controls. HTTP request-context logging is suppressed; service/TLS logs remain. Do not add debug/body/header logs. The app additionally checks loopback peer, exact Host/Origin, independent credentials and CSRF.

After approval, replace all placeholders and check `node --version`, `systemd-analyze verify /etc/systemd/system/fo-fix.service` and `caddy adapt --adapter caddyfile --config /etc/caddy/Caddyfile`. Adaptation parses configuration without running a server. Validate the installed Caddy version/configuration before activation. Activating public Caddy can obtain certificates and create issuer/account keys; its [automatic HTTPS requirements](https://caddyserver.com/docs/automatic-https) include correct DNS, reachable ports and persistent writable certificate state. That activation requires the TLS/network authorization above; never use `tls internal`, install a local root CA or disable certificate verification for Fo's public endpoint.

Only once approved and checked, the operator may run `sudo systemctl daemon-reload` and `sudo systemctl enable --now fo-fix caddy`. These are activation steps, not read-only preflight. No such commands were executed here.

## 4. Acceptance and persistence — approved fixture only

Before Fo registration, verify public TLS normally (no `curl -k`). The following contain no credentials and must return **401**:

```bash
fofix_origin='https://REPLACE_HOSTNAME'
curl --max-time 10 -sS -o /dev/null -w '%{http_code}\n' "$fofix_origin/api/status"
curl --max-time 10 -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' --data '{}' "$fofix_origin/mcp"
curl --max-time 10 -sS -o /dev/null -w '%{http_code}\n' \
  -H 'Forwarded: for=127.0.0.1;proto=http' -H 'X-Forwarded-For: 127.0.0.1' \
  -H 'X-Forwarded-Proto: http' "$fofix_origin/api/status"
```

The third test remains 401 because Caddy replaces the spoofed forwarding context and authentication is still missing. A foreign Origin must return 403; a foreign Host must be rejected (403/404/421, not successful content). On the VM, direct loopback HTTP with the correct Host but `X-Forwarded-Proto: http` must return 403 even when `Forwarded: proto=https` is added. Confirm the listener is only `127.0.0.1:4310` using `ss -ltn`; an external connection to 4310 must fail. These hosted checks are pending, not claimed by the offline tests.

In the browser and a separately configured MCP client, verify: anonymous denied; MCP cannot owner-login or approve; owner mutations without CSRF denied; a fixture repair requires exact approval; verification/history are synthetic; undo needs new approval. Record one verified fixture action and a different approved-but-unexecuted plan. With restart authorization, run `sudo systemctl restart fo-fix`: sign in again, confirm read consent is off, the pending approval is invalidated, and verified history plus fixture state persist. Old sessions/plans must not work. A separately authorized VM reboot must preserve the mounted disk and Caddy state. Test the missing-mount guard only during an approved maintenance window after stopping the app, never by unmounting an active database. An unexpected kill leaves uncertain actions visible and never retries writes.

The Mac may remain offline during cloud fixture acceptance. Real device sessions and native compilation/hardware remain separate work.

## 5. Offline evidence and teardown

Run `node deploy/gcp/offline-check.mjs` after a local build on Node 24.19.0. It starts only ephemeral loopback fixture processes, checks authentication/forwarding boundaries and restart persistence, parses a unit with local executable paths, and checks a missing mount is refused. It does not activate systemd, mount disks, install Caddy, contact GCP/DNS/CAs or use real credentials. If Caddy is already installed it performs adaptation only. [Recorded results](gcp-offline-checks.json) describe that historical preparation pass. The reviewed 2026-10-19 application source passed its build, **176 unit/API/relay tests and 39 browser tests**; these are engineering checks, not Fo demo successes.

Teardown is separately approval-gated: end access, stop services cleanly, remove the Fo connection/credential only with account authorization, and revoke the configured credentials. Inventory the exact VM, address, disk, firewall rule, DNS record and any backups created for this deployment. Delete only approved owned resources; preserve/export the journal first if retention was requested. Stopping a VM is not a complete teardown or a cost guarantee. Release/delete the approved address and retained disks only when explicitly authorized; do not alter shared networking, IAM or unrelated resources. Verify the final resource inventory and retained storage against the approved plan.

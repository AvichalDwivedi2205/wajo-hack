// Local-only synthetic deployment checks. No GCP, DNS, CA or model requests.
// Does not activate systemd, mount disks, install packages or create real keys.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
assert.equal(
  process.versions.node,
  "24.19.0",
  "Use the reviewed Node 24.19.0 runtime.",
);
await stat(join(root, "dist/index.html")); // Build first; no automatic installs.
const dir = await mkdtemp(join(tmpdir(), "fo-fix-gcp-offline-"));
const tokens = {
  mcp: "synthetic_vm_mcp_" + "a".repeat(43),
  owner: "synthetic_vm_owner_" + "b".repeat(43),
};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const template = await readFile(
  new URL("fo-fix.env.example", import.meta.url),
  "utf8",
);
const config = Object.fromEntries(
  template
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const split = line.indexOf("=");
      return [line.slice(0, split), line.slice(split + 1)];
    }),
);
assert.equal(config.FO_FIX_LISTEN_HOST, "127.0.0.1");
assert.equal(config.FO_FIX_TRUST_PROXY, "loopback");
assert.equal(config.FO_FIX_BACKEND, "fixture");
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const origin = "https://fix.fixture.invalid";
Object.assign(config, {
  FO_FIX_PUBLIC_ORIGIN: origin,
  FO_FIX_PORT: String(port),
  FO_FIX_DATA: join(dir, "fixture.sqlite"),
  FO_FIX_MCP_TOKEN_SHA256: digest(tokens.mcp),
  FO_FIX_OWNER_TOKEN_SHA256: digest(tokens.owner),
  FO_FIX_ACCESS_EXPIRES_AT: new Date(Date.now() + 60 * 60_000).toISOString(),
});
let running;
async function start() {
  const child = spawn(
    process.execPath,
    ["--use-env-proxy", "--import", "tsx", "src/server/main.ts", "--remote"],
    {
      cwd: root,
      env: { PATH: process.env.PATH, ...config },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  running = { child, exited };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Synthetic server did not become ready")),
      8000,
    );
    child.stderr.on("data", (chunk) => {
      if (chunk.toString().includes("Fo Fix: http://127.0.0.1:")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Synthetic server exited before readiness"));
    });
  });
}
async function stop() {
  if (!running) return;
  const current = running;
  running = undefined;
  if (current.child.exitCode === null && current.child.signalCode === null)
    current.child.kill("SIGTERM");
  const timer = setTimeout(() => current.child.kill("SIGKILL"), 10_000);
  try {
    const exit = await current.exited;
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
  } finally {
    clearTimeout(timer);
  }
}
function request(
  path,
  body,
  headers = {},
  method = body === undefined ? "GET" : "POST",
) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          Host: "fix.fixture.invalid",
          "X-Forwarded-Proto": "https",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              json: JSON.parse(text),
            });
          } catch {
            reject(new Error("Local check received a non-JSON response"));
          }
        });
      },
    );
    req.setTimeout(8000, () => req.destroy(new Error("Local check timed out")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function login() {
  const signed = await request(
    "/owner/auth/login",
    { credential: tokens.owner },
    { Origin: origin },
  );
  assert.equal(signed.status, 200);
  const cookie = signed.headers["set-cookie"][0].split(";")[0];
  const session = await request("/api/auth", undefined, { Cookie: cookie });
  assert.equal(session.status, 200);
  return {
    Cookie: cookie,
    Origin: origin,
    "X-FoFix-CSRF": session.json.csrfToken,
  };
}
const checks = {
  source: "synthetic local fixture only",
  cloudActionsExecuted: false,
  publicTLSRequestsMade: false,
};
try {
  await start();
  assert.equal((await request("/api/status")).status, 401);
  assert.equal((await request("/mcp", {})).status, 401);
  assert.equal(
    (await request("/mcp", {}, { Authorization: `Bearer ${tokens.owner}` }))
      .status,
    401,
  );
  assert.equal(
    (
      await request(
        "/owner/auth/login",
        { credential: tokens.mcp },
        { Origin: origin },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request(
        "/api/permission",
        {},
        { Origin: origin, Authorization: `Bearer ${tokens.mcp}` },
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/status", undefined, {
        Forwarded: "for=127.0.0.1;proto=https",
        "X-Forwarded-For": "127.0.0.1",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/owner/auth/method", undefined, {
        Host: "foreign.fixture.invalid",
        "X-Forwarded-Host": "fix.fixture.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/owner/auth/method", undefined, {
        "X-Forwarded-Proto": "http",
        Forwarded: "proto=https",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/owner/auth/method", undefined, {
        Origin: "https://foreign.fixture.invalid",
      })
    ).status,
    403,
  );
  checks.anonymousRejected =
    checks.authoritiesSeparate =
    checks.upstreamHostOriginForwardingGuards =
      true;
  const owner = await login();
  assert.equal(
    (
      await request(
        "/api/permission",
        {},
        { Cookie: owner.Cookie, Origin: origin },
      )
    ).status,
    403,
  );
  assert.equal((await request("/api/permission", {}, owner)).status, 200);
  const plan = (
    await request(
      "/api/plans",
      { recipe: "switch-output", deviceId: "fixture-speakers" },
      owner,
    )
  ).json;
  assert.equal(
    (
      await request(
        `/api/plans/${plan.id}/approve`,
        { digest: plan.digest },
        owner,
      )
    ).status,
    200,
  );
  const action = (await request(`/api/plans/${plan.id}/execute`, {}, owner))
    .json;
  assert.equal(action.state, "succeeded");
  assert.equal(action.source, "fixture");
  const pending = (
    await request(
      "/api/plans",
      { recipe: "switch-output", deviceId: "fixture-headphones" },
      owner,
    )
  ).json;
  assert.equal(
    (
      await request(
        `/api/plans/${pending.id}/approve`,
        { digest: pending.digest },
        owner,
      )
    ).status,
    200,
  );
  await stop();
  await start();
  assert.equal((await request("/api/auth", undefined, owner)).status, 401);
  const next = await login();
  const state = (await request("/api/status", undefined, next)).json;
  assert.equal(state.permission.active, false);
  assert.equal(
    state.actions.find((a) => a.id === action.id)?.state,
    "succeeded",
  );
  assert.equal(state.plans.find((p) => p.id === pending.id)?.status, "denied");
  assert.equal((await request("/api/permission", {}, next)).status, 200);
  assert.ok(
    (await request(`/api/plans/${pending.id}/execute`, {}, next)).status >= 400,
  );
  assert.equal(
    (await request("/api/inspect", {}, next)).json.outputId,
    "fixture-speakers",
  );
  assert.equal((await stat(config.FO_FIX_DATA)).mode & 0o777, 0o600);
  checks.sqliteHistoryAndFixturePersist =
    checks.restartRevokesReadAndPendingApproval =
    checks.ownerSessionDoesNotSurviveRestart =
    checks.databaseMode0600 =
    checks.csrfEnforced =
      true;
  await stop();
  const mount = spawnSync("mountpoint", ["--quiet", dir]);
  assert.equal(mount.status, 32);
  checks.missingMountRejected = true;
  const unit = await readFile(
    new URL("fo-fix.service", import.meta.url),
    "utf8",
  );
  const parsedUnit = join(dir, "fo-fix.service");
  await writeFile(
    parsedUnit,
    unit
      .replaceAll("/opt/node-v24.19.0/bin/node", process.execPath)
      .replace("WorkingDirectory=/opt/fo-fix", `WorkingDirectory=${root}`),
  );
  const syntax = spawnSync(
    "systemd-analyze",
    ["verify", "--man=no", parsedUnit],
    { encoding: "utf8" },
  );
  assert.equal(
    syntax.status,
    0,
    "Offline systemd parser failed; no unit was activated.",
  );
  checks.systemdSyntaxWithLocalExecutablePaths = true;
  const caddyFile = join(dir, "Caddyfile");
  await writeFile(
    caddyFile,
    (
      await readFile(new URL("Caddyfile.example", import.meta.url), "utf8")
    ).replace("REPLACE_HOSTNAME", "fix.fixture.invalid"),
  );
  const caddy = spawnSync(
    "caddy",
    ["adapt", "--adapter", "caddyfile", "--config", caddyFile],
    { encoding: "utf8" },
  );
  if (caddy.error?.code === "ENOENT")
    checks.caddyParsing =
      "blocked: Caddy executable unavailable; no binary installed";
  else {
    assert.equal(caddy.status, 0, "Caddy adaptation failed");
    checks.caddyParsing =
      "passed: adaptation only, no server or certificates started";
  }
  checks.remaining = [
    "Actual VM/systemd sandbox and mounted persistent disk",
    "Caddy installed-version validation and forwarded-header tests through real HTTPS",
    "Authorized DNS/CA provisioning, GCP access/resources and Fo registration",
    "Mac hardware validation",
  ];
  console.log(JSON.stringify(checks, null, 2));
} finally {
  await stop();
  await rm(dir, { recursive: true, force: true });
}

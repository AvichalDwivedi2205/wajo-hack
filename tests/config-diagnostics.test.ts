import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfig, loadConfig } from "../src/server/config.ts";
import {
  configurationDiagnostics,
  networkDiagnostics,
} from "../src/server/diagnostics.ts";

const valid = {
  FO_FIX_MODE: "remote",
  FO_FIX_AUTH_MODE: "oauth",
  FO_FIX_PUBLIC_ORIGIN: "https://fix.fixture.invalid",
  FO_FIX_AUTH_ISSUER: "https://identity.fixture.invalid/",
  FO_FIX_AUTH_JWKS_URL: "https://identity.fixture.invalid/jwks",
  FO_FIX_OWNER_AUTHORIZATION_URL: "https://identity.fixture.invalid/authorize",
  FO_FIX_OWNER_TOKEN_URL: "https://identity.fixture.invalid/token",
  FO_FIX_OWNER_CLIENT_ID: "fixture-owner",
  FO_FIX_MCP_CLIENT_ID: "fixture-mcp",
  FO_FIX_OWNER_SUBJECT: "fixture-human",
  FO_FIX_BACKEND: "fixture",
  FO_FIX_TRUST_PROXY: "loopback",
};
test("remote mode fails closed without complete identity, HTTPS and isolated-client configuration", () => {
  assert.throws(
    () => loadConfig({ FO_FIX_MODE: "remote" }),
    /Configuration is incomplete/,
  );
  assert.equal(checkConfig(valid).issues.length, 0);
  for (const replacement of [
    { FO_FIX_PUBLIC_ORIGIN: "http://fix.fixture.invalid" },
    { FO_FIX_OWNER_CLIENT_ID: valid.FO_FIX_MCP_CLIENT_ID },
    { FO_FIX_AUTH_JWKS_URL: "https://untrusted.fixture.invalid/jwks" },
    { FO_FIX_BACKEND: "macos" },
    { FO_FIX_BACKEND: "session" },
    { FO_FIX_TRUST_PROXY: "true" },
  ]) {
    assert.ok(checkConfig({ ...valid, ...replacement }).issues.length > 0);
  }
  assert.throws(
    () => loadConfig({ FO_FIX_PUBLIC_ORIGIN: valid.FO_FIX_PUBLIC_ORIGIN }),
    /FO_FIX_MODE/,
  );
});
test("diagnostics disclose presence and fixed issue messages without values or model calls", () => {
  const secret = "synthetic-secret-never-a-real-credential";
  const result = configurationDiagnostics({
    ...valid,
    ANTHROPIC_API_KEY: secret,
    HTTPS_PROXY: `http://fixture:${secret}@proxy.invalid`,
    FO_FIX_PUBLIC_ORIGIN: `https://fixture:${secret}@fix.fixture.invalid`,
  });
  assert.equal(result.anthropic.credentialPresent, true);
  assert.equal(result.anthropic.paidRequestMade, false);
  assert.equal(result.network.checked, false);
  assert.equal(result.configurationReady, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(configurationDiagnostics({}).anthropic.credentialPresent, false);
  assert.equal(
    configurationDiagnostics({}).anthropic.requiredVariable,
    "ANTHROPIC_API_KEY",
  );
});
test("the real remote entry point refuses missing identity before creating a journal or listener", () => {
  const dir = mkdtempSync(join(tmpdir(), "fo-fix-remote-guard-"));
  const database = join(dir, "must-not-exist.sqlite");
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/server/main.ts", "--remote"],
      {
        env: { PATH: process.env.PATH, FO_FIX_DATA: database },
        encoding: "utf8",
        timeout: 8000,
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Configuration is incomplete/);
    assert.doesNotMatch(result.stderr, /Fo Fix: http/);
    assert.equal(existsSync(database), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("optional network diagnostics use fixed unauthenticated HEAD probes and sanitize proxy failures", async () => {
  let calls = 0;
  const result = await networkDiagnostics(async (_url, init) => {
    calls++;
    assert.equal(init?.method, "HEAD");
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    if (calls === 1) return new Response(null, { status: 403 });
    throw new TypeError("do not print synthetic-secret", {
      cause: new Error("private proxy details", { cause: { statusCode: 403 } }),
    });
  });
  assert.deepEqual(
    result.map((r) => r.status),
    ["denied", "denied_by_proxy"],
  );
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
  assert.equal(calls, 2);
});

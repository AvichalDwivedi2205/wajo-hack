import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { identityFixture, remoteFixture } from "./support/remote.ts";
import {
  checkConfig,
  loadConfig,
  type BearerRemoteConfig,
} from "../src/server/config.ts";
import { SessionBroker } from "../src/server/session.ts";
import { trustedProxyCheck } from "../src/server/proxy.ts";

// Fixed, explicitly synthetic credentials. Never used for a real deployment.
const tokens = {
  mcp: "synthetic_mcp_" + "a".repeat(43),
  owner: "synthetic_owner_" + "b".repeat(43),
  companion: "synthetic_companion_" + "c".repeat(43),
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function environment() {
  return {
    FO_FIX_MODE: "remote",
    FO_FIX_AUTH_MODE: "bearer",
    FO_FIX_PUBLIC_ORIGIN: "https://fix.fixture.invalid",
    FO_FIX_BACKEND: "fixture",
    FO_FIX_TRUST_PROXY: "loopback",
    FO_FIX_MCP_TOKEN_SHA256: digest(tokens.mcp),
    FO_FIX_OWNER_TOKEN_SHA256: digest(tokens.owner),
    FO_FIX_ACCESS_EXPIRES_AT: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}
async function fixture(session = false, addresses = ["127.0.0.1", "::1"]) {
  const identity = await identityFixture();
  const config: BearerRemoteConfig = {
    ...loadConfig(environment()),
    mode: "remote",
    authMode: "bearer",
    port: 4310,
    origin: identity.config.origin,
    backend: session ? "session" : "fixture",
    deviceId: "fixture-device",
    listenHost: "0.0.0.0",
    trustedProxyAddresses: addresses,
    mcpTokenHash: digest(tokens.mcp),
    ownerTokenHash: digest(tokens.owner),
    companionTokenHash: session ? digest(tokens.companion) : undefined,
    accessExpiresAt: identity.clock() + 60 * 60_000,
  };
  const broker = session
    ? new SessionBroker("fixture-device", identity.clock)
    : undefined;
  const app = await remoteFixture(identity, broker, config);
  const login = async () => {
    const result = await app.request("/owner/auth/login", {
      method: "POST",
      headers: { Origin: config.origin },
      body: { credential: tokens.owner },
    });
    assert.equal(result.status, 200);
    const header = result.headers["set-cookie"]![0];
    assert.match(header, /Secure/);
    assert.match(header, /HttpOnly/);
    assert.match(header, /SameSite=Strict/);
    const cookie = header.split(";")[0];
    const auth = await app.request("/api/auth", {
      headers: { Cookie: cookie },
    });
    assert.equal(auth.status, 200);
    return {
      cookie,
      headers: {
        Cookie: cookie,
        Origin: config.origin,
        "X-FoFix-CSRF": auth.json().csrfToken as string,
      },
    };
  };
  return { ...app, identity, config, login, broker };
}

test("deployment deadline is returned only to the authenticated owner and bounds the session", async () => {
  const app = await fixture();
  try {
    const anonymous = await app.request("/api/auth");
    assert.equal(anonymous.status, 401);
    assert.equal(Object.hasOwn(anonymous.json(), "deploymentExpiresAt"), false);
    const method = await app.request("/owner/auth/method");
    assert.deepEqual(method.json(), { method: "bearer" });
    const owner = await app.login();
    const auth = await app.request("/api/auth", {
      headers: { Cookie: owner.cookie },
    });
    assert.equal(auth.json().deploymentExpiresAt, app.config.accessExpiresAt);
    assert.ok(auth.json().expiresAt <= app.config.accessExpiresAt);
    const mcp = await app.request("/api/auth", {
      headers: { Authorization: `Bearer ${tokens.mcp}` },
    });
    assert.equal(mcp.status, 401);
    assert.equal(Object.hasOwn(mcp.json(), "deploymentExpiresAt"), false);
  } finally {
    await app.close();
  }
});

test("explicit bearer configuration needs no OAuth provider and rejects shared credentials, unbounded proxy trust and missing or excessive expiry", () => {
  const env = environment();
  assert.equal(checkConfig(env).issues.length, 0);
  assert.equal(loadConfig(env).mode, "remote");
  for (const replacement of [
    { FO_FIX_AUTH_MODE: "" },
    { FO_FIX_OWNER_TOKEN_SHA256: env.FO_FIX_MCP_TOKEN_SHA256 },
    { FO_FIX_MCP_TOKEN_SHA256: "plaintext-not-a-digest" },
    { FO_FIX_ACCESS_EXPIRES_AT: "" },
    { FO_FIX_ACCESS_EXPIRES_AT: new Date(Date.now() - 1000).toISOString() },
    {
      FO_FIX_ACCESS_EXPIRES_AT: new Date(
        Date.now() + 25 * 60 * 60_000,
      ).toISOString(),
    },
    { FO_FIX_LISTEN_HOST: "0.0.0.0" },
    { FO_FIX_TRUST_PROXY: "true" },
    { FO_FIX_TRUST_PROXY: "addresses", FO_FIX_PROXY_ADDRESSES: "10.0.0.0/8" },
    { FO_FIX_TRUST_PROXY: "addresses", FO_FIX_PROXY_ADDRESSES: "0.0.0.0" },
    { FO_FIX_BACKEND: "session" },
  ])
    assert.ok(checkConfig({ ...env, ...replacement }).issues.length > 0);
  const valid = loadConfig({
    ...env,
    PORT: "8080",
    FO_FIX_TRUST_PROXY: "addresses",
    FO_FIX_PROXY_ADDRESSES: "10.0.0.9,10.0.0.10",
    FO_FIX_LISTEN_HOST: "0.0.0.0",
  });
  assert.equal(valid.port, 8080);
});

test("Fo-style explicit bearer MCP cannot sign in or approve; separate owner cookie plus CSRF enables verified fixture repair and separately approved undo", async () => {
  const app = await fixture();
  const client = new Client({ name: "synthetic-Fo-bearer", version: "1" });
  try {
    assert.equal(
      (await app.request("/owner/auth/method")).json().method,
      "bearer",
    );
    const discovery = await app.request(
      "/.well-known/oauth-protected-resource/mcp",
    );
    assert.equal(discovery.status, 404);
    for (const role of ["mcp", "companion"] as const) {
      assert.equal(
        (
          await app.request("/owner/auth/login", {
            method: "POST",
            headers: { Origin: app.config.origin },
            body: { credential: tokens[role] },
          })
        ).status,
        401,
      );
      assert.equal(
        (
          await app.request("/api/permission", {
            method: "POST",
            headers: {
              Origin: app.config.origin,
              Authorization: `Bearer ${tokens[role]}`,
            },
            body: {},
          })
        ).status,
        401,
      );
    }
    for (const role of ["owner", "companion"] as const)
      assert.equal(
        (
          await app.request("/mcp", {
            method: "POST",
            headers: { Authorization: `Bearer ${tokens[role]}` },
            body: {},
          })
        ).status,
        401,
      );
    const owner = await app.login();
    assert.equal(
      (
        await app.request("/api/permission", {
          method: "POST",
          headers: { Cookie: owner.cookie, Origin: app.config.origin },
          body: {},
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request("/api/permission", {
          method: "POST",
          headers: owner.headers,
          body: {},
        })
      ).status,
      200,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${app.config.origin}/mcp`), {
        fetch: app.fetcher,
        requestInit: { headers: { Authorization: `Bearer ${tokens.mcp}` } },
      }),
    );
    assert.equal((await client.listTools()).tools.length, 5);
    const proposed = await client.callTool({
      name: "fo_fix_propose_repair",
      arguments: { recipe: "switch-output", deviceId: "fixture-speakers" },
    });
    const plan = (proposed.structuredContent as any).result;
    assert.equal(
      (
        await client.callTool({
          name: "fo_fix_execute_approved",
          arguments: { planId: plan.id },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await app.request(`/api/plans/${plan.id}/approve`, {
          method: "POST",
          headers: { ...owner.headers, Authorization: `Bearer ${tokens.mcp}` },
          body: { digest: plan.digest },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await app.request(`/api/plans/${plan.id}/approve`, {
          method: "POST",
          headers: owner.headers,
          body: { digest: plan.digest },
        })
      ).status,
      200,
    );
    const result = (
      await client.callTool({
        name: "fo_fix_execute_approved",
        arguments: { planId: plan.id },
      })
    ).structuredContent as any;
    assert.equal(result.result.state, "succeeded");
    assert.equal(result.result.source, "fixture");
    const undo = (
      await client.callTool({
        name: "fo_fix_propose_undo",
        arguments: { actionId: result.result.id },
      })
    ).structuredContent as any;
    assert.equal(
      (
        await client.callTool({
          name: "fo_fix_execute_approved",
          arguments: { planId: undo.result.id },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await app.request(`/api/plans/${undo.result.id}/approve`, {
          method: "POST",
          headers: owner.headers,
          body: { digest: undo.result.digest },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        (
          await client.callTool({
            name: "fo_fix_execute_approved",
            arguments: { planId: undo.result.id },
          })
        ).structuredContent as any
      ).result.state,
      "succeeded",
    );
    assert.equal(
      (
        await app.request("/owner/auth/logout", {
          method: "POST",
          headers: owner.headers,
          body: {},
        })
      ).status,
      200,
    );
    assert.equal(
      (await app.request("/api/status", { headers: { Cookie: owner.cookie } }))
        .status,
      401,
    );
    assert.equal(app.engine.status().permission.active, false);
  } finally {
    await client.close();
    await app.close();
  }
});

test("bearer access fails closed for query credentials, foreign origins, owner-session expiry, deployment expiry and rate-limited login guesses", async () => {
  const app = await fixture();
  try {
    const anonymous = await app.request(`/mcp?token=${tokens.mcp}`, {
      method: "POST",
      body: {},
    });
    assert.equal(anonymous.status, 401);
    assert.doesNotMatch(
      String(anonymous.headers["www-authenticate"]),
      /resource_metadata/,
    );
    assert.equal(anonymous.text.includes(tokens.mcp), false);
    assert.equal(
      (
        await app.request("/owner/auth/login", {
          method: "POST",
          headers: { Origin: "https://foreign.fixture.invalid" },
          body: { credential: tokens.owner },
        })
      ).status,
      403,
    );
    const owner = await app.login();
    app.identity.advance(16 * 60_000);
    assert.equal(
      (await app.request("/api/auth", { headers: { Cookie: owner.cookie } }))
        .status,
      401,
    );
    assert.equal(
      (
        await app.request("/mcp", {
          method: "GET",
          headers: { Authorization: `Bearer ${tokens.mcp}` },
        })
      ).status,
      405,
    );
    const next = await app.login();
    app.identity.advance(45 * 60_000);
    assert.equal(
      (await app.request("/api/auth", { headers: { Cookie: next.cookie } }))
        .status,
      401,
    );
    assert.equal(
      (
        await app.request("/mcp", {
          method: "POST",
          headers: { Authorization: `Bearer ${tokens.mcp}` },
          body: {},
        })
      ).json().code,
      "ACCESS_EXPIRED",
    );
  } finally {
    await app.close();
  }
  const attempts = await fixture();
  try {
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await attempts.request("/owner/auth/login", {
            method: "POST",
            headers: { Origin: attempts.config.origin },
            body: { credential: tokens.mcp },
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await attempts.request("/owner/auth/login", {
          method: "POST",
          headers: { Origin: attempts.config.origin },
          body: { credential: tokens.owner },
        })
      ).status,
      429,
    );
    attempts.identity.advance(60_000);
    await attempts.login();
  } finally {
    await attempts.close();
  }
});

test("exact trusted proxy allowlist rejects nonproxy peers and spoofed forwarding headers while preserving Host and Origin checks", async () => {
  const accepts = trustedProxyCheck(["10.0.0.9", "::1"]);
  assert.equal(accepts("10.0.0.9"), true);
  assert.equal(accepts("::ffff:10.0.0.9"), true);
  assert.equal(accepts("10.0.0.10"), false);
  assert.equal(accepts("127.0.0.1"), false);
  assert.equal(accepts(undefined), false);
  const denied = await fixture(false, ["10.0.0.9"]);
  try {
    assert.equal(
      (
        await denied.request("/owner/auth/method", {
          headers: {
            "X-Forwarded-For": "10.0.0.9",
            Forwarded: "for=10.0.0.9;proto=https",
          },
        })
      ).status,
      403,
    );
  } finally {
    await denied.close();
  }
  const allowed = await fixture(false, ["127.0.0.1"]);
  try {
    assert.equal((await allowed.request("/owner/auth/method")).status, 200);
    assert.equal(
      (
        await allowed.request("/owner/auth/method", {
          headers: { Host: "foreign.fixture.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await allowed.request("/owner/auth/method", {
          headers: { Origin: "https://foreign.fixture.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await allowed.request("/owner/auth/method", {
          headers: { "X-Forwarded-Proto": "https,http" },
        })
      ).status,
      403,
    );
  } finally {
    await allowed.close();
  }
});

test("a separate companion bearer authenticates only device relay; even cloud owner sessions cannot grant or approve device operations", async () => {
  const app = await fixture(true);
  try {
    for (const role of ["mcp", "owner"] as const)
      assert.equal(
        (
          await app.request("/session/connect", {
            method: "POST",
            headers: { Authorization: `Bearer ${tokens[role]}` },
            body: { deviceId: "fixture-device", source: "fixture" },
          })
        ).status,
        401,
      );
    const connected = await app.request("/session/connect", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.companion}` },
      body: { deviceId: "fixture-device", source: "fixture" },
    });
    assert.equal(connected.status, 200);
    assert.ok(connected.json().expiresAt <= app.identity.clock() + 20 * 60_000);
    const owner = await app.login();
    assert.equal(
      (
        await app.request("/api/permission", {
          method: "POST",
          headers: owner.headers,
          body: {},
        })
      ).json().code,
      "LOCAL_COMPANION_REQUIRED",
    );
    assert.equal(
      (
        await app.request(
          "/api/plans/00000000-0000-4000-8000-000000000000/approve",
          {
            method: "POST",
            headers: owner.headers,
            body: { digest: "a".repeat(64) },
          },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request("/api/device-session/end", {
          method: "POST",
          headers: owner.headers,
          body: {},
        })
      ).status,
      200,
    );
  } finally {
    await app.close();
  }
});

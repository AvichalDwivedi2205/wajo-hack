import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJwt } from "jose";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RemoteAuth } from "../src/server/auth.ts";
import { identityFixture, remoteFixture } from "./support/remote.ts";

test("remote MCP validates signed access tokens, audience, client, subject, scope, type and expiry", async () => {
  const identity = await identityFixture();
  const auth = new RemoteAuth(identity.config, {
    key: identity.key,
    clock: identity.clock,
  });
  const valid = await identity.token("mcp");
  assert.equal(
    (await auth.verify(valid, "mcp")).subject,
    identity.config.ownerSubject,
  );
  const payload = decodeJwt(valid);
  for (const changed of [
    { ...payload, iss: "https://other.fixture.invalid" },
    { ...payload, aud: `${identity.config.origin}/owner` },
    {
      ...payload,
      aud: [`${identity.config.origin}/mcp`, `${identity.config.origin}/owner`],
    },
    { ...payload, client_id: identity.config.ownerClientId },
    { ...payload, sub: "another-human" },
    { ...payload, scope: "fofix:mcp fofix:owner" },
    { ...payload, scope: "openid" },
    { ...payload, exp: Math.floor(identity.clock() / 1000) - 1 },
    { ...payload, exp: Math.floor(identity.clock() / 1000) + 7200 },
  ]) {
    await assert.rejects(auth.verify(await identity.signed(changed), "mcp"));
  }
  await assert.rejects(
    auth.verify(await identity.signed(payload, "JWT"), "mcp"),
  );
  await assert.rejects(auth.verify(valid.slice(0, -8) + "corrupt!", "mcp"));
});

test("remote startup rejects anonymous MCP and owner API; protected-resource discovery remains public", async () => {
  const identity = await identityFixture();
  const app = await remoteFixture(identity);
  try {
    const denied = await app.request("/mcp", { method: "POST", body: {} });
    assert.equal(denied.status, 401);
    assert.match(
      String(denied.headers["www-authenticate"]),
      /resource_metadata/,
    );
    assert.equal((await app.request("/api/status")).status, 401);
    assert.equal((await app.request("/api/diagnostics")).status, 401);
    const metadata = await app.request(
      "/.well-known/oauth-protected-resource/mcp",
    );
    assert.equal(metadata.status, 200);
    assert.equal(metadata.json().resource, `${identity.config.origin}/mcp`);
    assert.deepEqual(metadata.json().scopes_supported, ["fofix:mcp"]);
    assert.equal(
      (
        await app.request("/mcp?access_token=synthetic-not-a-token", {
          method: "POST",
          body: {},
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await app.request("/api/auth", {
          headers: { "X-Forwarded-Proto": "http" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request("/api/auth", {
          headers: { Host: "evil.fixture.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request("/owner/auth/login", {
          method: "POST",
          headers: { Origin: "https://evil.fixture.invalid" },
          body: {},
        })
      ).status,
      403,
    );
  } finally {
    await app.close();
  }
});

test("owner PKCE session and CSRF protect grants and approvals; MCP bearer cannot become owner", async () => {
  const identity = await identityFixture();
  const app = await remoteFixture(identity);
  try {
    const token = await identity.token("mcp");
    const authorization = {
      Authorization: `Bearer ${token}`,
      Origin: identity.config.origin,
    };
    assert.equal(
      (
        await app.request("/api/permission", {
          method: "POST",
          headers: authorization,
          body: {},
        })
      ).status,
      401,
    );
    const owner = await app.login();
    const ownerHeaders = {
      Cookie: owner.cookie,
      Origin: identity.config.origin,
      "X-FoFix-CSRF": owner.csrf,
    };
    assert.equal(
      (
        await app.request("/api/permission", {
          method: "POST",
          headers: { Cookie: owner.cookie, Origin: identity.config.origin },
          body: {},
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request("/api/permission", {
          method: "POST",
          headers: { ...ownerHeaders, "X-FoFix-CSRF": "incorrect" },
          body: {},
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await app.request("/api/permission", {
          method: "POST",
          headers: ownerHeaders,
          body: {},
        })
      ).status,
      200,
    );
    const client = new Client({
      name: "synthetic-authenticated-remote-test",
      version: "1",
    });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`${identity.config.origin}/mcp`),
          {
            fetch: app.fetcher,
            requestInit: { headers: { Authorization: `Bearer ${token}` } },
          },
        ),
      );
      assert.equal((await client.listTools()).tools.length, 5);
      const proposed = await client.callTool({
        name: "fo_fix_propose_repair",
        arguments: { recipe: "switch-output", deviceId: "fixture-speakers" },
      });
      const plan = (
        proposed.structuredContent as { result: { id: string; digest: string } }
      ).result;
      assert.equal(
        (
          await app.request(`/api/plans/${plan.id}/approve`, {
            method: "POST",
            headers: {
              ...authorization,
              Cookie: owner.cookie,
              "X-FoFix-CSRF": owner.csrf,
            },
            body: { digest: plan.digest },
          })
        ).status,
        401,
      );
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
            headers: ownerHeaders,
            body: { digest: plan.digest },
          })
        ).status,
        200,
      );
      const execution = await client.callTool({
        name: "fo_fix_execute_approved",
        arguments: { planId: plan.id },
      });
      assert.equal(
        (
          execution.structuredContent as {
            result: { state: string; source: string };
          }
        ).result.state,
        "succeeded",
      );
      assert.equal(
        (execution.structuredContent as { result: { source: string } }).result
          .source,
        "fixture",
      );
    } finally {
      await client.close();
    }
    assert.equal(
      (
        await app.request("/owner/auth/logout", {
          method: "POST",
          headers: ownerHeaders,
          body: {},
        })
      ).status,
      200,
    );
    assert.equal(app.engine.status().permission.active, false);
    assert.equal(
      (await app.request("/api/status", { headers: { Cookie: owner.cookie } }))
        .status,
      401,
    );
  } finally {
    await app.close();
  }
});

test("login callback state is cookie-bound, single-use and cannot exchange an MCP token for an owner session", async () => {
  const identity = await identityFixture();
  const app = await remoteFixture(identity);
  try {
    const owner = await app.login();
    assert.equal(
      (
        await app.request(owner.callback, {
          headers: { Cookie: owner.loginCookie },
        })
      ).status,
      403,
    );
    const start = await app.request("/owner/auth/login", {
      method: "POST",
      headers: { Origin: identity.config.origin },
      body: {},
    });
    const target = new URL(start.json().authorizationUrl);
    const state = target.searchParams.get("state")!;
    identity.setChallenge(target.searchParams.get("code_challenge")!);
    const path = `/owner/auth/callback?state=${state}&code=synthetic-code`;
    assert.equal((await app.request(path)).status, 403);
    identity.setTokenRole("mcp");
    assert.equal(
      (
        await app.request(path, {
          headers: { Cookie: start.headers["set-cookie"]![0].split(";")[0] },
        })
      ).status,
      401,
    );
  } finally {
    await app.close();
  }
});

test("owner sessions expire and owner/companion tokens are rejected by MCP", async () => {
  const identity = await identityFixture();
  const app = await remoteFixture(identity);
  try {
    const owner = await app.login();
    for (const role of ["owner", "companion"] as const) {
      assert.equal(
        (
          await app.request("/mcp", {
            method: "POST",
            body: {},
            headers: { Authorization: `Bearer ${await identity.token(role)}` },
          })
        ).status,
        401,
      );
    }
    identity.advance(16 * 60_000);
    assert.equal(
      (await app.request("/api/auth", { headers: { Cookie: owner.cookie } }))
        .status,
      401,
    );
  } finally {
    await app.close();
  }
});

test("remote JWKS verification reads only the pinned HTTPS key endpoint with bounded responses and no redirect following", async () => {
  const identity = await identityFixture();
  const urls: string[] = [];
  const auth = new RemoteAuth(identity.config, {
    clock: identity.clock,
    fetch: async (url, options) => {
      urls.push(String(url));
      assert.equal(options?.redirect, "error");
      return Response.json(identity.jwks);
    },
  });
  await auth.verify(await identity.token("mcp"), "mcp");
  assert.deepEqual(urls, [identity.config.jwksUrl]);
});

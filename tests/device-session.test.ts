import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { FixtureAdapter } from "../src/companion/adapter.ts";
import { createApp } from "../src/server/app.ts";
import { SessionBroker } from "../src/server/session.ts";
import { runDeviceSession } from "../src/companion/bridge.ts";
import { FixError } from "../src/core/errors.ts";
import { identityFixture, remoteFixture } from "./support/remote.ts";

async function localCompanion() {
  const store = new Store();
  const engine = new Engine(store, new FixtureAdapter(store));
  // A fresh port prevents fetch's shared keep-alive pool from reusing a socket
  // belonging to a just-closed companion from the preceding test.
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const { app, errors } = createApp(engine, port);
  app.use(errors);
  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const post = async (path: string, body = {}) => {
    const response = await fetch(`${origin}/api/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  return {
    engine,
    post,
    port,
    close: async () => {
      await engine.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

for (const authMode of ["oauth", "bearer"] as const)
  test(
    `${authMode}: authenticated remote MCP relay preserves local inspection consent, exact approval, verification and separately approved undo`,
    { timeout: 15_000 },
    async () => {
      const identity = await identityFixture("session");
      const broker = new SessionBroker(identity.config.deviceId!);
      const synthetic = {
        mcp: "synthetic_relay_mcp_" + "a".repeat(43),
        owner: "synthetic_relay_owner_" + "b".repeat(43),
        companion: "synthetic_relay_companion_" + "c".repeat(43),
      };
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const config =
        authMode === "oauth"
          ? identity.config
          : {
              ...identity.config,
              authMode: "bearer" as const,
              mcpTokenHash: digest(synthetic.mcp),
              ownerTokenHash: digest(synthetic.owner),
              companionTokenHash: digest(synthetic.companion),
              accessExpiresAt: Date.now() + 60 * 60_000,
            };
      const gateway = await remoteFixture(identity, broker, config);
      const local = await localCompanion();
      const controller = new AbortController();
      let started!: () => void;
      const connected = new Promise<void>((resolve) => {
        started = resolve;
      });
      const finished = runDeviceSession({
        origin: identity.config.origin,
        accessToken:
          authMode === "oauth"
            ? await identity.token("companion")
            : synthetic.companion,
        deviceId: identity.config.deviceId!,
        localPort: local.port,
        signal: controller.signal,
        fetcher: gateway.fetcher,
        onConnected: () => started(),
      }).then(
        () => ({ ok: true }),
        () => ({ ok: false }),
      );
      const client = new Client({
        name: "synthetic-remote-relay-acceptance",
        version: "1",
      });
      try {
        await connected;
        await client.connect(
          new StreamableHTTPClientTransport(
            new URL(`${identity.config.origin}/mcp`),
            {
              fetch: gateway.fetcher,
              requestInit: {
                headers: {
                  Authorization: `Bearer ${authMode === "oauth" ? await identity.token("mcp") : synthetic.mcp}`,
                },
              },
            },
          ),
        );
        const state = await client.callTool({
          name: "fo_fix_status",
          arguments: {},
        });
        assert.equal(
          (state.structuredContent as { result: { mode: string } }).result.mode,
          "fixture",
        );
        assert.equal(
          (state.structuredContent as { result: { approvalAuthority: string } })
            .result.approvalAuthority,
          "companion",
        );
        assert.equal(
          (
            await client.callTool({
              name: "fo_fix_inspect_output",
              arguments: {},
            })
          ).isError,
          true,
        );
        const owner =
          authMode === "oauth"
            ? await gateway.login()
            : await (async () => {
                const login = await gateway.request("/owner/auth/login", {
                  method: "POST",
                  headers: { Origin: config.origin },
                  body: { credential: synthetic.owner },
                });
                assert.equal(login.status, 200);
                const cookie = login.headers["set-cookie"]![0].split(";")[0];
                const auth = await gateway.request("/api/auth", {
                  headers: { Cookie: cookie },
                });
                return { cookie, csrf: auth.json().csrfToken as string };
              })();
        const headers = {
          Cookie: owner.cookie,
          Origin: identity.config.origin,
          "X-FoFix-CSRF": owner.csrf,
        };
        assert.equal(
          (
            await gateway.request("/api/permission", {
              method: "POST",
              headers,
              body: {},
            })
          ).status,
          403,
        );
        assert.equal(local.engine.status().permission.active, false);
        await local.post("permission");
        const proposal = await client.callTool({
          name: "fo_fix_propose_repair",
          arguments: { recipe: "switch-output", deviceId: "fixture-speakers" },
        });
        const plan = (
          proposal.structuredContent as {
            result: { id: string; digest: string };
          }
        ).result;
        assert.equal(
          (
            await gateway.request(`/api/plans/${plan.id}/approve`, {
              method: "POST",
              headers,
              body: { digest: plan.digest },
            })
          ).status,
          403,
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
        await local.post(`plans/${plan.id}/approve`, { digest: plan.digest });
        const execution = await client.callTool({
          name: "fo_fix_execute_approved",
          arguments: { planId: plan.id },
        });
        const action = (
          execution.structuredContent as {
            result: { id: string; source: string; state: string };
          }
        ).result;
        assert.equal(action.source, "fixture");
        assert.equal(action.state, "succeeded");
        assert.equal(
          (await local.engine.inspect()).outputId,
          "fixture-speakers",
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
        const undoResult = await client.callTool({
          name: "fo_fix_propose_undo",
          arguments: { actionId: action.id },
        });
        const undo = (
          undoResult.structuredContent as {
            result: { id: string; digest: string };
          }
        ).result;
        assert.equal(
          (
            await client.callTool({
              name: "fo_fix_execute_approved",
              arguments: { planId: undo.id },
            })
          ).isError,
          true,
        );
        await local.post(`plans/${undo.id}/approve`, { digest: undo.digest });
        assert.equal(
          (
            await client.callTool({
              name: "fo_fix_execute_approved",
              arguments: { planId: undo.id },
            })
          ).isError,
          undefined,
        );
        assert.equal((await local.engine.inspect()).outputId, "fixture-hdmi");
        const approveAndExecute = async (
          proposal: Awaited<ReturnType<typeof client.callTool>>,
        ) => {
          const plan = (
            proposal.structuredContent as {
              result: { id: string; digest: string };
            }
          ).result;
          await local.post(`plans/${plan.id}/approve`, { digest: plan.digest });
          const result = await client.callTool({
            name: "fo_fix_execute_approved",
            arguments: { planId: plan.id },
          });
          const action = (
            result.structuredContent as {
              result: { id: string; state: string; source: string };
            }
          ).result;
          assert.equal(action.state, "succeeded");
          assert.equal(action.source, "fixture");
          return action;
        };
        const routed = await approveAndExecute(
          await client.callTool({
            name: "fo_fix_propose_repair",
            arguments: {
              recipe: "switch-output",
              deviceId: "fixture-headphones",
            },
          }),
        );
        const unmuted = await approveAndExecute(
          await client.callTool({
            name: "fo_fix_propose_repair",
            arguments: { recipe: "unmute-output" },
          }),
        );
        assert.equal(
          (await local.engine.inspect()).devices.find(
            (d) => d.id === "fixture-headphones",
          )?.muted,
          false,
        );
        await approveAndExecute(
          await client.callTool({
            name: "fo_fix_propose_undo",
            arguments: { actionId: unmuted.id },
          }),
        );
        assert.equal(
          (await local.engine.inspect()).devices.find(
            (d) => d.id === "fixture-headphones",
          )?.muted,
          true,
        );
        await approveAndExecute(
          await client.callTool({
            name: "fo_fix_propose_undo",
            arguments: { actionId: routed.id },
          }),
        );
        assert.equal(
          (
            await gateway.request("/api/device-session/end", {
              method: "POST",
              headers,
              body: {},
            })
          ).status,
          200,
        );
        await finished;
        assert.equal((await broker.status()).mode, "unavailable");
        assert.equal(local.engine.status().actions.length, 6);
      } finally {
        controller.abort();
        await broker.shutdown();
        await finished;
        await client.close();
        await gateway.close();
        await local.close();
      }
    },
  );

test("session delivery is single-use, duplicate results are idempotent and expired sessions cannot reconnect automatically", async () => {
  let now = Date.now();
  const broker = new SessionBroker("fixture-device", () => now);
  try {
    assert.throws(() => broker.connect("other-device", "fixture"));
    const session = broker.connect("fixture-device", "fixture");
    assert.throws(() => broker.connect("fixture-device", "fixture"));
    const pending = broker.inspect();
    const job = await broker.poll(
      session.sessionId,
      new AbortController().signal,
    );
    assert.ok(job);
    const result = { structuredContent: { result: { source: "fixture" } } };
    broker.complete(session.sessionId, job.id, result);
    broker.complete(session.sessionId, job.id, result);
    assert.deepEqual(await pending, { source: "fixture" });
    assert.throws(() =>
      broker.complete(session.sessionId, job.id, {
        structuredContent: { result: "different" },
      }),
    );
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(
      await broker.poll(session.sessionId, aborted.signal),
      undefined,
    );
    now += 20 * 60_000 + 1;
    await assert.rejects(broker.inspect());
    await assert.rejects(broker.poll(session.sessionId, aborted.signal));
  } finally {
    await broker.shutdown();
  }
});

test("a delivered execution timeout is uncertain and is never redelivered", async () => {
  const broker = new SessionBroker("fixture-device", Date.now, 25);
  const session = broker.connect("fixture-device", "fixture");
  try {
    const execution = broker.execute(randomUUID());
    const rejected = assert.rejects(
      execution,
      (error) =>
        error instanceof FixError && error.code === "EXECUTION_UNCERTAIN",
    );
    const job = await broker.poll(
      session.sessionId,
      new AbortController().signal,
    );
    assert.ok(job);
    await rejected;
    const aborted = new AbortController();
    aborted.abort();
    assert.equal(
      await broker.poll(session.sessionId, aborted.signal),
      undefined,
    );
    assert.throws(() =>
      broker.complete(session.sessionId, job.id, {
        structuredContent: { result: {} },
      }),
    );
  } finally {
    await broker.shutdown();
  }
});

test(
  "malformed companion results settle the original request instead of orphaning it",
  { timeout: 2000 },
  async () => {
    const broker = new SessionBroker("fixture-device");
    const session = broker.connect("fixture-device", "fixture");
    try {
      for (const structuredContent of [
        1,
        "bad",
        true,
        [],
        null,
        undefined,
        {},
        { result: undefined },
      ]) {
        const pending = broker.inspect();
        const rejected = assert.rejects(
          pending,
          (error) =>
            error instanceof FixError && error.code === "INVALID_DEVICE_RESULT",
        );
        const job = await broker.poll(
          session.sessionId,
          new AbortController().signal,
        );
        assert.ok(job);
        assert.doesNotThrow(() =>
          broker.complete(session.sessionId, job.id, { structuredContent }),
        );
        await rejected;
      }
    } finally {
      await broker.shutdown();
    }
  },
);

for (const end of ["deadline", "cancellation"] as const)
  test(`bridge does not start a delivered approved execution after ${end} during its long poll`, async () => {
    const local = await localCompanion();
    let now = Date.now();
    const expiresAt = now + 1000;
    const controller = new AbortController();
    let calls = 0;
    try {
      local.engine.grantPermission();
      const plan = await local.engine.propose(
        "switch-output",
        "fixture-speakers",
      );
      await local.engine.approve(plan.id, plan.digest);
      await runDeviceSession({
        origin: "https://fix.fixture.invalid",
        accessToken: "synthetic-test-only-token",
        deviceId: "fixture-device",
        localPort: local.port,
        signal: controller.signal,
        clock: () => now,
        fetcher: async () => {
          calls++;
          if (calls === 1)
            return Response.json({ sessionId: randomUUID(), expiresAt });
          if (end === "deadline") now = expiresAt + 1;
          else controller.abort();
          return Response.json({
            job: {
              id: randomUUID(),
              request: {
                tool: "fo_fix_execute_approved",
                args: { planId: plan.id },
              },
            },
          });
        },
      });
      assert.equal(calls, 2);
      assert.equal(local.engine.status().actions.length, 0);
      assert.equal((await local.engine.inspect()).outputId, "fixture-hdmi");
    } finally {
      await local.close();
    }
  });

test("device bridge rejects owner/terminal commands supplied by a gateway before calling the local MCP client", async () => {
  const local = await localCompanion();
  let calls = 0;
  try {
    await assert.rejects(
      runDeviceSession({
        origin: "https://fix.fixture.invalid",
        accessToken: "synthetic-test-only-token",
        deviceId: "fixture-device",
        localPort: local.port,
        signal: new AbortController().signal,
        fetcher: async () => {
          calls++;
          return calls === 1
            ? Response.json({
                sessionId: randomUUID(),
                expiresAt: Date.now() + 60_000,
              })
            : Response.json({
                job: {
                  id: randomUUID(),
                  request: {
                    tool: "approve",
                    args: { command: "arbitrary-terminal-is-forbidden" },
                  },
                },
              });
        },
      }),
    );
    assert.equal(calls, 2);
    assert.equal(local.engine.status().plans.length, 0);
    assert.equal(local.engine.status().permission.active, false);
  } finally {
    await local.close();
  }
});

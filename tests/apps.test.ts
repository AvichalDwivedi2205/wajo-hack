import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { FixtureAdapter } from "../src/companion/adapter.ts";
import { AppEngine } from "../src/apps/engine.ts";
import { FixtureAppAdapter } from "../src/apps/adapter.ts";
import { createApp } from "../src/server/app.ts";
import type { OwnerService } from "../src/core/service.ts";
import { agentRequest } from "../src/shared/relay.ts";
import { SessionBroker } from "../src/server/session.ts";
import { appInspection, type AppAgent } from "../src/apps/contracts.ts";

function fixture() {
  const store = new Store(),
    adapter = new FixtureAppAdapter();
  let now = Date.now();
  const engine = new AppEngine(store, adapter, () => now);
  return {
    store,
    adapter,
    engine,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
async function relayResult<T>(
  call: (apps: AppAgent) => Promise<T>,
  result: unknown,
) {
  const broker = new SessionBroker("test-device", Date.now, 1000, false, true);
  const session = broker.connect("test-device", "fixture");
  try {
    const operation = call(broker.apps!);
    const job = await broker.poll(
      session.sessionId,
      new AbortController().signal,
    );
    assert(job);
    broker.complete(session.sessionId, job.id, { structuredContent: { result } });
    return await operation;
  } finally {
    broker.disconnect();
  }
}
test("app relay binds a pending proposal to the requested app", async () => {
  const c = fixture();
  try {
    c.engine.grant();
    const plan = await c.engine.propose("spotify");
    assert.deepEqual(
      await relayResult((apps) => apps.propose("spotify"), plan),
      plan,
    );
    for (const forged of [
      { ...plan, appId: "music" },
      { ...plan, status: "approved" },
    ])
      await assert.rejects(
        relayResult((apps) => apps.propose("spotify"), forged),
        (error) => (error as { code: string }).code === "INVALID_DEVICE_RESULT",
      );
  } finally {
    c.store.close();
  }
});
test("app relay rejects success for another plan or without matching verified facts", async () => {
  const c = fixture();
  try {
    c.engine.grant();
    const plan = await c.engine.propose("spotify");
    await c.engine.approve(plan.id, plan.digest);
    const action = await c.engine.execute(plan.id);
    assert.deepEqual(
      await relayResult((apps) => apps.execute(plan.id), action),
      action,
    );
    for (const forged of [
      { ...action, planId: "11111111-1111-4111-8111-111111111111" },
      { ...action, completedAt: undefined },
      { ...action, after: undefined },
      { ...action, after: { ...action.after!, active: false } },
      { ...action, after: { ...action.after!, running: false } },
      { ...action, after: { ...action.after!, installed: false } },
      { ...action, after: { ...action.after!, identity: "" } },
      { ...action, after: { ...action.after!, name: "Another app" } },
      { ...action, after: { ...action.after!, bundleId: "other.bundle" } },
      { ...action, after: c.adapter.facts.music },
      { ...action, state: "executing" },
      { ...action, source: "macos" },
    ])
      await assert.rejects(
        relayResult((apps) => apps.execute(plan.id), forged),
        (error) => (error as { code: string }).code === "INVALID_DEVICE_RESULT",
      );
    // Uncertainty remains a valid final result; it is never promoted to success.
    const uncertain = { ...action, state: "uncertain", after: undefined };
    assert.deepEqual(
      await relayResult((apps) => apps.execute(plan.id), uncertain),
      uncertain,
    );
  } finally {
    c.store.close();
  }
});
test("app inspection rejects duplicated or contradictory catalog facts while preserving mixed history", async () => {
  const c = fixture();
  try {
    c.engine.grant();
    const inspection = await c.engine.inspect();
    for (const forged of [
      {
        ...inspection,
        apps: [inspection.apps[0], inspection.apps[0], inspection.apps[2]],
      },
      ...[
        { name: "Another app" },
        { bundleId: "other.bundle" },
        { identity: "" },
      ].map((change) => ({
        ...inspection,
        apps: inspection.apps.map((a, i) => (i ? a : { ...a, ...change })),
      })),
      { ...inspection, source: "macos" },
    ])
      await assert.rejects(
        relayResult((apps) => apps.inspect(), forged),
        (error) => (error as { code: string }).code === "INVALID_DEVICE_RESULT",
      );
    const plan = await c.engine.propose("spotify");
    await c.engine.approve(plan.id, plan.digest);
    const action = await c.engine.execute(plan.id);
    // These are synthetic schema examples, not evidence of a native launch.
    // App provenance is independent of audio mode and historical action sources.
    const nativeShapedFacts = inspection.apps.map((fact) => ({
      ...fact,
      identity: `/Applications/${fact.name}.app#${"a".repeat(40)}`,
    }));
    const mixed = {
      ...inspection,
      source: "macos",
      apps: nativeShapedFacts,
      actions: [action],
    };
    assert.equal(appInspection.safeParse(mixed).success, true);
    assert.deepEqual(await relayResult((apps) => apps.inspect(), mixed), mixed);
  } finally {
    c.store.close();
  }
});
test("app opening requires separate consent, exact approval, verifies result and consumes approval once", async () => {
  const c = fixture();
  try {
    await assert.rejects(c.engine.inspect(), /Allow supported-app inspection/);
    c.engine.grant();
    const p = await c.engine.propose("spotify");
    assert.equal(c.adapter.facts.spotify.running, false);
    await assert.rejects(c.engine.execute(p.id), /fresh local approval/);
    await assert.rejects(
      c.engine.approve(p.id, "0".repeat(64)),
      /does not match/,
    );
    await c.engine.approve(p.id, p.digest);
    assert.equal(c.adapter.facts.spotify.running, false);
    const action = await c.engine.execute(p.id);
    assert.equal(action.state, "succeeded");
    assert.equal(action.source, "fixture");
    assert.equal(action.after?.active, true);
    await assert.rejects(c.engine.execute(p.id), /fresh local approval/);
  } finally {
    c.store.close();
  }
});
test("changed app, expiry and replacement consent block an approved launch", async () => {
  const c = fixture();
  try {
    c.engine.grant();
    let p = await c.engine.propose("spotify");
    await c.engine.approve(p.id, p.digest);
    c.adapter.facts.spotify.identity += ":updated";
    await assert.rejects(c.engine.execute(p.id), /installed app changed/);
    p = await c.engine.propose("spotify");
    await c.engine.approve(p.id, p.digest);
    c.advance(5 * 60_000);
    await assert.rejects(c.engine.execute(p.id), /expired/);
    p = await c.engine.propose("spotify");
    await c.engine.approve(p.id, p.digest);
    c.engine.grant();
    await assert.rejects(c.engine.execute(p.id), /fresh local approval/);
    assert.equal(c.adapter.facts.spotify.running, false);
  } finally {
    c.store.close();
  }
});
test("missing Spotify refuses a proposal without substituting another app", async () => {
  const c = fixture();
  try {
    c.engine.grant();
    c.adapter.facts.spotify.installed = false;
    await assert.rejects(c.engine.propose("spotify"), /not installed/);
    assert.equal(c.engine.status().plans.length, 0);
  } finally {
    c.store.close();
  }
});
test("every executable approval remains visible locally despite a long closed-plan history", async () => {
  const c = fixture();
  try {
    c.engine.grant();
    const p = await c.engine.propose("spotify");
    await c.engine.approve(p.id, p.digest);
    for (let i = 0; i < 25; i++) {
      const other = await c.engine.propose("music");
      c.engine.deny(other.id);
    }
    assert(
      c.engine
        .status()
        .plans.some((plan) => plan.id === p.id && plan.status === "approved"),
    );
    c.engine.deny(p.id);
    await assert.rejects(c.engine.execute(p.id));
    for (let i = 0; i < 20; i++) await c.engine.propose("music");
    await assert.rejects(
      c.engine.propose("calculator"),
      /outstanding app proposals/,
    );
  } finally {
    c.store.close();
  }
});
for (const cancellation of ["revoke", "replace", "expire", "shutdown"] as const)
  test(`app ${cancellation} during launch preserves uncertainty and prevents another inspection`, async () => {
    const c = fixture();
    try {
      c.engine.grant();
      const p = await c.engine.propose("spotify");
      await c.engine.approve(p.id, p.digest);
      let reads = 0;
      const inspect = c.adapter.inspect.bind(c.adapter);
      c.adapter.inspect = async (id) => {
        reads++;
        return inspect(id);
      };
      c.adapter.open = async () => {
        if (cancellation === "revoke") c.engine.revoke();
        else if (cancellation === "replace") c.engine.grant();
        else if (cancellation === "expire") c.advance(20 * 60_000);
        else void c.engine.shutdown();
      };
      assert.equal((await c.engine.execute(p.id)).state, "uncertain");
      assert.equal(reads, 1);
    } finally {
      c.store.close();
    }
  });
test("a delivered app-opening relay timeout is uncertain and cannot be redelivered", async () => {
  const broker = new SessionBroker("test-device", Date.now, 30, false, true);
  const session = broker.connect("test-device", "fixture");
  try {
    const operation = broker.apps!.execute(
      "00000000-0000-4000-8000-000000000000",
    );
    const failure = assert.rejects(
      operation,
      (error) => (error as { code: string }).code === "EXECUTION_UNCERTAIN",
    );
    const job = await broker.poll(
      session.sessionId,
      new AbortController().signal,
    );
    assert(job);
    await failure;
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await broker.poll(session.sessionId, controller.signal),
      undefined,
    );
    assert.throws(
      () =>
        broker.complete(session.sessionId, job.id, {
          structuredContent: { result: {} },
        }),
      /expired/,
    );
  } finally {
    broker.disconnect();
  }
});
for (const cancellation of ["deny", "revoke", "replace"] as const)
  test(`app ${cancellation} during pre-launch inspection prevents launch`, async () => {
    const c = fixture();
    try {
      c.engine.grant();
      const p = await c.engine.propose("calculator");
      await c.engine.approve(p.id, p.digest);
      const read = c.adapter.inspect.bind(c.adapter);
      c.adapter.inspect = async (id) => {
        const fact = await read(id);
        if (cancellation === "deny") c.engine.deny(p.id);
        else if (cancellation === "revoke") c.engine.revoke();
        else c.engine.grant();
        return fact;
      };
      await assert.rejects(c.engine.execute(p.id));
      assert.equal(c.adapter.facts.calculator.running, false);
      assert.equal(c.engine.status().actions.length, 0);
    } finally {
      c.store.close();
    }
  });
test("uncertain app launch and restart never replay a consumed approval", async () => {
  const c = fixture();
  try {
    c.engine.grant();
    const p = await c.engine.propose("music");
    await c.engine.approve(p.id, p.digest);
    let calls = 0;
    c.adapter.open = async () => {
      calls++;
      throw new Error("test interruption");
    };
    assert.equal((await c.engine.execute(p.id)).state, "uncertain");
    await assert.rejects(c.engine.execute(p.id));
    assert.equal(calls, 1);
    c.store.data.apps!.actions[0].state = "executing";
    const restarted = new AppEngine(c.store, c.adapter);
    assert.equal(restarted.status().actions[0].state, "uncertain");
    assert.equal(restarted.status().permission.active, false);
  } finally {
    c.store.close();
  }
});
test("MCP and relay reject arbitrary apps, commands, paths, URLs and approval tools", () => {
  for (const args of [
    { appId: "terminal" },
    { appId: "spotify", url: "spotify:track:123" },
    { appId: "spotify", command: "play" },
    { appId: "/Applications/Spotify.app" },
  ])
    assert.equal(
      agentRequest.safeParse({ tool: "apps.propose_open", args }).success,
      false,
    );
  assert.equal(
    agentRequest.safeParse({ tool: "apps.approve", args: {} }).success,
    false,
  );
});
test("SDK app flow preserves local authority, denies cross-origin consent and never opens during approval", async () => {
  const c = fixture(),
    actor: OwnerService = new Engine(c.store, new FixtureAdapter(c.store));
  actor.apps = c.engine;
  const { app, errors } = createApp(actor, 4329);
  app.use(errors);
  const server = app.listen(4329, "127.0.0.1");
  await once(server, "listening");
  const client = new Client({ name: "synthetic-app-test", version: "1" });
  const post = (path: string, body = {}, origin = "http://127.0.0.1:4329") =>
    fetch(`http://127.0.0.1:4329/api/apps/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  const call = (name: string, args = {}) =>
    client.callTool({ name, arguments: args });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4329/mcp")),
    );
    assert.equal(
      (await post("permission", {}, "https://evil.invalid")).status,
      403,
    );
    assert.equal((await call("apps.inspect")).isError, true);
    assert.equal((await post("permission")).status, 200);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert(names.includes("apps.open_approved"));
    assert(!names.includes("apps.approve"));
    const p = (
      (await call("apps.propose_open", { appId: "spotify" }))
        .structuredContent as { result: { id: string; digest: string } }
    ).result;
    assert.equal(
      (await call("apps.open_approved", { id: p.id })).isError,
      true,
    );
    assert.equal(
      (await post(`plans/${p.id}/approve`, { digest: p.digest })).status,
      200,
    );
    assert.equal(c.adapter.facts.spotify.running, false);
    assert.equal(
      (
        (await call("apps.open_approved", { id: p.id })).structuredContent as {
          result: { state: string };
        }
      ).result.state,
      "succeeded",
    );
    assert.equal(
      (await call("apps.open_approved", { id: p.id })).isError,
      true,
    );
    assert.equal(
      (await post("plans", { appId: "spotify", command: "play" })).status,
      400,
    );
  } finally {
    await client.close();
    await c.engine.shutdown();
    await actor.shutdown();
    await new Promise<void>((r) => server.close(() => r()));
    c.store.close();
  }
});
test("session relay carries strict app metadata and keeps owner approval local", async () => {
  const c = fixture(),
    broker = new SessionBroker("test-device", Date.now, 5000, false, true);
  const session = broker.connect("test-device", "fixture");
  const deliver = async (operation: Promise<unknown>) => {
    const job = await broker.poll(
      session.sessionId,
      new AbortController().signal,
    );
    assert(job);
    const args = job.request.args as { appId?: "spotify"; id?: string };
    let result;
    if (job.request.tool === "apps.inspect") result = await c.engine.inspect();
    else if (job.request.tool === "apps.propose_open")
      result = await c.engine.propose(args.appId!);
    else result = await c.engine.execute(args.id!);
    broker.complete(session.sessionId, job.id, {
      structuredContent: { result },
    });
    return operation;
  };
  try {
    c.engine.grant();
    const p = (await deliver(broker.apps!.propose("spotify"))) as {
      id: string;
      digest: string;
    };
    await assert.rejects(broker.approve(), /local device interface/);
    await c.engine.approve(p.id, p.digest);
    assert.equal(
      ((await deliver(broker.apps!.execute(p.id))) as { state: string }).state,
      "succeeded",
    );
    assert.equal(
      ((await deliver(broker.apps!.inspect())) as { apps: unknown[] }).apps
        .length,
      3,
    );
    const invalid = broker.apps!.inspect();
    const job = await broker.poll(
      session.sessionId,
      new AbortController().signal,
    );
    assert(job);
    broker.complete(session.sessionId, job.id, {
      structuredContent: { result: { secret: "rejected" } },
    });
    await assert.rejects(invalid, /invalid or excessive/);
  } finally {
    broker.disconnect();
    await c.engine.shutdown();
    c.store.close();
  }
});

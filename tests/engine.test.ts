import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine, revision } from "../src/core/engine.ts";
import { Store } from "../src/core/store.ts";
import { FixtureAdapter } from "../src/companion/adapter.ts";
import { FixError } from "../src/core/errors.ts";
import { MAX_AGENT_STATUS_BYTES } from "../src/shared/limits.ts";

function setup() {
  let now = Date.now();
  const store = new Store();
  const adapter = new FixtureAdapter(store);
  const engine = new Engine(store, adapter, () => now);
  return {
    store,
    adapter,
    engine,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const code = (expected: string) => (e: unknown) =>
  e instanceof FixError && e.code === expected;
test("agent history stays bounded as the full local journal grows", async () => {
  const ctx = setup();
  try {
    ctx.engine.grantPermission();
    for (let i = 0; i < 160; i++)
      await ctx.engine.propose("switch-output", "fixture-speakers");
    const status = ctx.engine.status("agent");
    assert.equal(status.history.planCount, 160);
    assert.equal(status.history.truncated, true);
    assert.equal(status.plans[0].id, ctx.store.data.plans.at(-1)!.id);
    assert.ok(
      Buffer.byteLength(JSON.stringify(status)) <= MAX_AGENT_STATUS_BYTES,
    );
    assert.equal(ctx.engine.status().plans.length, 160);
    // Even a single unusually large snapshot must fit the remote envelope.
    ctx.store.data.fixture.devices = Array.from({ length: 128 }, (_, i) => ({
      id: String(i),
      name: "\u0001".repeat(256),
      transport: "\u0001".repeat(64),
      alive: true,
      muted: false,
    }));
    ctx.store.data.fixture.outputId = "0";
    await ctx.engine.propose("switch-output", "1");
    assert.ok(
      Buffer.byteLength(JSON.stringify(ctx.engine.status("agent"))) <=
        MAX_AGENT_STATUS_BYTES,
    );
    assert.equal(ctx.engine.status().plans.length, 161);
  } finally {
    ctx.store.close();
  }
});
async function approved(
  ctx: ReturnType<typeof setup>,
  recipe: "switch-output" | "unmute-output" = "switch-output",
  device = "fixture-speakers",
) {
  ctx.engine.grantPermission();
  const plan = await ctx.engine.propose(
    recipe,
    recipe === "switch-output" ? device : undefined,
  );
  await ctx.engine.approve(plan.id, plan.digest);
  return plan;
}
test("inspection and proposals require a temporary permission lease", async () => {
  const { engine } = setup();
  await assert.rejects(engine.inspect(), code("PERMISSION_REQUIRED"));
  await assert.rejects(
    engine.propose("switch-output", "fixture-speakers"),
    code("PERMISSION_REQUIRED"),
  );
});
test("fixture repair verifies a fresh read and undo restores the original state with separate approval", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  const result = await ctx.engine.execute(p.id);
  assert.equal(result.source, "fixture");
  assert.equal(result.state, "succeeded");
  assert.equal(result.verification?.status, "passed");
  assert.equal((await ctx.engine.inspect()).outputId, "fixture-speakers");
  const undo = await ctx.engine.proposeUndo(result.id);
  await assert.rejects(ctx.engine.execute(undo.id), code("APPROVAL_REQUIRED"));
  await ctx.engine.approve(undo.id, undo.digest);
  const reversed = await ctx.engine.execute(undo.id);
  assert.equal(reversed.state, "succeeded");
  assert.equal((await ctx.engine.inspect()).outputId, "fixture-hdmi");
  await assert.rejects(
    ctx.engine.proposeUndo(result.id),
    code("UNDO_UNAVAILABLE"),
  );
});
test("execution without approval and after denial cannot change state", async () => {
  const { engine } = setup();
  engine.grantPermission();
  const p = await engine.propose("switch-output", "fixture-speakers");
  await assert.rejects(engine.execute(p.id), code("APPROVAL_REQUIRED"));
  await engine.deny(p.id);
  await assert.rejects(
    engine.approve(p.id, p.digest),
    code("PLAN_NOT_PENDING"),
  );
  assert.equal((await engine.inspect()).outputId, "fixture-hdmi");
});
test("approval is bound to exact digest and expires", async () => {
  const ctx = setup();
  ctx.engine.grantPermission();
  const p = await ctx.engine.propose("switch-output", "fixture-speakers");
  await assert.rejects(
    ctx.engine.approve(p.id, "bad-digest"),
    code("PLAN_MISMATCH"),
  );
  ctx.advance(5 * 60_000 + 1);
  await assert.rejects(
    ctx.engine.approve(p.id, p.digest),
    code("PLAN_EXPIRED"),
  );
});
test("approved plans also expire before execution", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  ctx.advance(5 * 60_000 + 1);
  await assert.rejects(ctx.engine.execute(p.id), code("PLAN_EXPIRED"));
});
test("revocation invalidates approvals and blocks future reads", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  ctx.engine.revokePermission();
  await assert.rejects(ctx.engine.execute(p.id), code("PERMISSION_REQUIRED"));
  ctx.engine.grantPermission();
  await assert.rejects(ctx.engine.execute(p.id), code("APPROVAL_REQUIRED"));
});
test("lease expiry blocks writes despite earlier approval", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  ctx.advance(20 * 60_000 + 1);
  await assert.rejects(ctx.engine.execute(p.id), code("PERMISSION_REQUIRED"));
});
test("revocation while native pre-write inspection is in flight prevents the write", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  const inspect = ctx.adapter.inspect.bind(ctx.adapter);
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const reading = new Promise<void>((r) => {
    started = r;
  });
  let writes = 0;
  ctx.adapter.apply = async () => {
    writes++;
  };
  ctx.adapter.inspect = async () => {
    started();
    await barrier;
    return inspect();
  };
  const pending = ctx.engine.execute(p.id);
  await reading;
  ctx.engine.revokePermission();
  release();
  await assert.rejects(pending, code("PERMISSION_REQUIRED"));
  assert.equal(writes, 0);
  assert.equal(ctx.store.data.actions.length, 0);
});
test("revocation while native inspection is in flight prevents returning state", async () => {
  const ctx = setup();
  ctx.engine.grantPermission();
  const inspect = ctx.adapter.inspect.bind(ctx.adapter);
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const reading = new Promise<void>((r) => {
    started = r;
  });
  ctx.adapter.inspect = async () => {
    started();
    await barrier;
    return inspect();
  };
  const pending = ctx.engine.inspect();
  await reading;
  ctx.engine.revokePermission();
  release();
  await assert.rejects(pending, code("PERMISSION_REQUIRED"));
});
test("device drift before approval and after approval fails closed", async () => {
  const ctx = setup();
  ctx.engine.grantPermission();
  const p = await ctx.engine.propose("switch-output", "fixture-speakers");
  ctx.store.data.fixture.devices[0].muted = true;
  await assert.rejects(
    ctx.engine.approve(p.id, p.digest),
    code("STATE_CHANGED"),
  );
  const next = await ctx.engine.propose("switch-output", "fixture-speakers");
  await ctx.engine.approve(next.id, next.digest);
  ctx.store.data.fixture.devices[0].muted = false;
  await assert.rejects(ctx.engine.execute(next.id), code("STATE_CHANGED"));
  assert.equal(
    ctx.store.data.plans.find((p) => p.id === next.id)?.status,
    "denied",
  );
});
test("concurrent replay executes at most once", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  let calls = 0;
  const original = ctx.adapter.apply.bind(ctx.adapter);
  ctx.adapter.apply = async (change) => {
    calls++;
    await original(change);
  };
  const results = await Promise.allSettled([
    ctx.engine.execute(p.id),
    ctx.engine.execute(p.id),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(calls, 1);
});
test("undo refuses to overwrite a newer external setting", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  const result = await ctx.engine.execute(p.id);
  ctx.store.data.fixture.devices[0].muted = true;
  await assert.rejects(
    ctx.engine.proposeUndo(result.id),
    code("STATE_CHANGED"),
  );
});
test("verification failure is reported and no automatic retry occurs", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  let calls = 0;
  ctx.adapter.apply = async () => {
    calls++;
  };
  const result = await ctx.engine.execute(p.id);
  assert.equal(result.state, "failed");
  assert.equal(result.verification?.status, "failed");
  assert.equal(calls, 1);
  await assert.rejects(ctx.engine.execute(p.id), code("APPROVAL_REQUIRED"));
  await assert.rejects(
    ctx.engine.proposeUndo(result.id),
    code("UNDO_UNAVAILABLE"),
  );
});
test("adapter error after partial write stays uncertain, journaled, and non-replayable", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  const original = ctx.adapter.apply.bind(ctx.adapter);
  ctx.adapter.apply = async (c) => {
    assert.equal(ctx.store.data.actions.at(-1)?.state, "executing");
    assert.equal(ctx.store.data.plans.at(-1)?.status, "consumed");
    await original(c);
    throw new Error("device disconnected");
  };
  const result = await ctx.engine.execute(p.id);
  assert.equal(result.state, "uncertain");
  assert.equal(result.after?.outputId, "fixture-speakers");
  assert.equal(result.verification?.status, "unavailable");
  await assert.rejects(ctx.engine.execute(p.id), code("APPROVAL_REQUIRED"));
});
test("unmute is scoped to active output and undo restores its prior mute state", async () => {
  const ctx = setup();
  ctx.store.data.fixture.outputId = "fixture-headphones";
  const p = await approved(ctx, "unmute-output");
  const a = await ctx.engine.execute(p.id);
  assert.equal(
    a.after?.devices.find((d) => d.id === "fixture-headphones")?.muted,
    false,
  );
  const undo = await ctx.engine.proposeUndo(a.id);
  await ctx.engine.approve(undo.id, undo.digest);
  await ctx.engine.execute(undo.id);
  assert.equal(
    (await ctx.engine.inspect()).devices.find(
      (d) => d.id === "fixture-headphones",
    )?.muted,
    true,
  );
});
test("unsupported or unavailable controls do not produce a plan", async () => {
  const ctx = setup();
  ctx.engine.grantPermission();
  await assert.rejects(
    ctx.engine.propose("switch-output", "invented"),
    code("DEVICE_UNAVAILABLE"),
  );
  await assert.rejects(ctx.engine.propose("unmute-output"), code("NO_CHANGE"));
  ctx.store.data.fixture.devices[1].muted = null;
  await assert.rejects(
    ctx.engine.propose("unmute-output"),
    code("UNSUPPORTED_CONTROL"),
  );
  await assert.rejects(
    ctx.engine.propose("shell" as never),
    code("UNSUPPORTED_RECIPE"),
  );
});
test("history persists; interrupted writes become uncertain; access and approvals do not survive restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fo-fix-"));
  const path = join(dir, "test.sqlite");
  try {
    const store = new Store(path);
    const engine = new Engine(store, new FixtureAdapter(store));
    engine.grantPermission();
    const p = await engine.propose("switch-output", "fixture-speakers");
    await engine.approve(p.id, p.digest);
    const a = await engine.execute(p.id);
    const outstanding = await engine.propose(
      "switch-output",
      "fixture-headphones",
    );
    await engine.approve(outstanding.id, outstanding.digest);
    const unreviewed = await engine.propose(
      "switch-output",
      "fixture-headphones",
    );
    store.data.actions[0].state = "executing";
    store.save();
    store.close();
    const reopened = new Store(path);
    const next = new Engine(reopened, new FixtureAdapter(reopened));
    assert.equal(next.status().actions[0].id, a.id);
    assert.equal(next.status().actions[0].state, "uncertain");
    assert.equal(next.status().permission.active, false);
    assert.equal(
      next.status().plans.find((p) => p.id === outstanding.id)?.status,
      "denied",
    );
    assert.equal(
      next.status().plans.find((p) => p.id === unreviewed.id)?.status,
      "denied",
    );
    next.grantPermission();
    await assert.rejects(next.execute(p.id), code("APPROVAL_REQUIRED"));
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("two companion processes cannot keep separate mutable copies of one journal", () => {
  const dir = mkdtempSync(join(tmpdir(), "fo-fix-lock-"));
  const path = join(dir, "test.sqlite");
  const first = new Store(path);
  try {
    assert.throws(() => new Store(path), /locked/);
  } finally {
    first.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function holdNextRead(ctx: ReturnType<typeof setup>) {
  const inspect = ctx.adapter.inspect.bind(ctx.adapter);
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const reading = new Promise<void>((r) => {
    started = r;
  });
  ctx.adapter.inspect = async () => {
    started();
    await barrier;
    return inspect();
  };
  return { release: () => release(), reading };
}

test("declining an approved plan interrupts its pre-write read instead of waiting behind execution", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  const hold = holdNextRead(ctx);
  let writes = 0;
  ctx.adapter.apply = async () => {
    writes++;
  };
  const execution = ctx.engine.execute(p.id);
  await hold.reading;
  const cancellation = ctx.engine.deny(p.id);
  try {
    assert.equal(ctx.store.data.plans[0].status, "denied");
  } finally {
    hold.release();
  }
  await cancellation;
  await assert.rejects(execution, code("APPROVAL_REQUIRED"));
  assert.equal(writes, 0);
  assert.equal(ctx.store.data.actions.length, 0);
});

test("declining a plan interrupts an in-flight approval check", async () => {
  const ctx = setup();
  ctx.engine.grantPermission();
  const p = await ctx.engine.propose("switch-output", "fixture-speakers");
  const hold = holdNextRead(ctx);
  const approval = ctx.engine.approve(p.id, p.digest);
  await hold.reading;
  await ctx.engine.deny(p.id);
  hold.release();
  await assert.rejects(approval, code("PLAN_NOT_PENDING"));
  assert.equal(
    ctx.store.data.events.some((e) => e.kind === "plan.approved"),
    false,
  );
});

test("revoking and regranting permission cannot revive an old in-flight read or proposal", async () => {
  for (const operation of ["inspect", "propose"] as const) {
    const ctx = setup();
    ctx.engine.grantPermission();
    const hold = holdNextRead(ctx);
    const pending =
      operation === "inspect"
        ? ctx.engine.inspect()
        : ctx.engine.propose("switch-output", "fixture-speakers");
    await hold.reading;
    ctx.engine.revokePermission();
    ctx.engine.grantPermission();
    hold.release();
    await assert.rejects(pending, code("PERMISSION_CHANGED"));
    assert.equal(ctx.store.data.plans.length, 0);
  }
});

test("approval and execution deadlines are checked again after asynchronous inspection", async () => {
  for (const operation of ["approve", "execute"] as const) {
    const ctx = setup();
    ctx.engine.grantPermission();
    const p = await ctx.engine.propose("switch-output", "fixture-speakers");
    if (operation === "execute") await ctx.engine.approve(p.id, p.digest);
    const hold = holdNextRead(ctx);
    const pending =
      operation === "approve"
        ? ctx.engine.approve(p.id, p.digest)
        : ctx.engine.execute(p.id);
    await hold.reading;
    ctx.advance(5 * 60_000 + 1);
    hold.release();
    await assert.rejects(pending, code("PLAN_EXPIRED"));
    assert.equal(ctx.store.data.actions.length, 0);
  }
});

test("every write retires other approvals so identical later state cannot revive them", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  const other = await ctx.engine.propose("switch-output", "fixture-headphones");
  await ctx.engine.approve(other.id, other.digest);
  await ctx.engine.execute(p.id);
  // Synthetic external change returns the fixture to the old observed state.
  ctx.store.data.fixture.outputId = "fixture-hdmi";
  await assert.rejects(ctx.engine.execute(other.id), code("APPROVAL_REQUIRED"));
  assert.equal(ctx.store.data.actions.length, 1);
  assert.ok(
    ctx.store.data.events.some(
      (e) => e.kind === "plan.invalidated" && e.subjectId === other.id,
    ),
  );
});

test("replacing an inspection lease invalidates pending and approved plans", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  const pending = await ctx.engine.propose(
    "switch-output",
    "fixture-headphones",
  );
  ctx.engine.grantPermission();
  await assert.rejects(ctx.engine.execute(p.id), code("APPROVAL_REQUIRED"));
  await assert.rejects(
    ctx.engine.approve(pending.id, pending.digest),
    code("PLAN_NOT_PENDING"),
  );
});

test("shutdown cancels a pre-write read and refuses new permission grants", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  const hold = holdNextRead(ctx);
  const execution = ctx.engine.execute(p.id);
  await hold.reading;
  const stopped = ctx.engine.shutdown();
  hold.release();
  await assert.rejects(execution, code("COMPANION_STOPPING"));
  await stopped;
  assert.equal(ctx.store.data.actions.length, 0);
  assert.equal(ctx.engine.status().lifecycle, "stopping");
  assert.throws(() => ctx.engine.grantPermission(), code("COMPANION_STOPPING"));
});

test("shutdown waits for an already-started write to verify and journal its result", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  const apply = ctx.adapter.apply.bind(ctx.adapter);
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const writing = new Promise<void>((r) => {
    started = r;
  });
  ctx.adapter.apply = async (change) => {
    started();
    await barrier;
    await apply(change);
  };
  const execution = ctx.engine.execute(p.id);
  await writing;
  let completed = false;
  const stopped = ctx.engine.shutdown().then(() => {
    completed = true;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(ctx.engine.status().permission.active, false);
  release();
  const result = await execution;
  await stopped;
  assert.equal(result.state, "succeeded");
  assert.equal(ctx.store.data.actions[0].verification?.status, "passed");
  ctx.store.close();
});

test("state revision is independent of device and object-property ordering", async () => {
  const ctx = setup();
  const state = await ctx.adapter.inspect();
  const reordered = {
    outputId: state.outputId,
    devices: [...state.devices].reverse().map((d) => ({
      muted: d.muted,
      alive: d.alive,
      transport: d.transport,
      name: d.name,
      id: d.id,
    })),
  };
  assert.equal(revision(state), revision(reordered));
});

test("agent history is withheld after revocation while the local human journal remains available", async () => {
  const ctx = setup();
  const p = await approved(ctx);
  await ctx.engine.execute(p.id);
  ctx.engine.revokePermission();
  const status = ctx.engine.status("agent");
  assert.equal(status.history.redacted, true);
  assert.equal(status.history.actionCount, 1);
  assert.deepEqual(status.actions, []);
  assert.deepEqual(status.plans, []);
  assert.deepEqual(status.events, []);
  assert.equal(JSON.stringify(status).includes("MacBook Speakers"), false);
  assert.equal(ctx.engine.status().actions.length, 1);
});

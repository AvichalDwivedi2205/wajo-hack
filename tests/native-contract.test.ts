import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNativeState, FixtureAdapter } from "../src/companion/adapter.ts";
import { Engine } from "../src/core/engine.ts";
import { Store } from "../src/core/store.ts";
import { FixError } from "../src/core/errors.ts";

// Synthetic native wire fixtures. These do not execute Swift or inspect hardware.
const device = {
  id: "42",
  name: "Synthetic unsupported control",
  transport: "USB",
  alive: true,
};
for (const muted of [undefined, null, false, true]) {
  test(`native wire contract preserves mute capability: ${String(muted)}`, () => {
    const state = parseNativeState({
      outputId: "42",
      devices: [{ ...device, ...(muted === undefined ? {} : { muted }) }],
    });
    assert.equal(state.devices[0].muted, muted ?? null);
  });
}
test("native wire contract rejects ambiguous mute values and unrecognized fields", () => {
  for (const value of [
    { ...device, muted: "false" },
    { ...device, muted: 0 },
    { ...device, muted: false, command: "forbidden" },
  ])
    assert.throws(() => parseNativeState({ outputId: "42", devices: [value] }));
});
test("missing native mute capability remains inspectable but cannot authorize a mute repair", async () => {
  const store = new Store();
  try {
    store.data.fixture = parseNativeState({
      outputId: "42",
      devices: [device],
    });
    const engine = new Engine(store, new FixtureAdapter(store));
    engine.grantPermission();
    assert.equal((await engine.inspect()).devices[0].muted, null);
    await assert.rejects(
      engine.propose("unmute-output"),
      (error) =>
        error instanceof FixError && error.code === "UNSUPPORTED_CONTROL",
    );
    assert.equal(engine.status().plans.length, 0);
    assert.equal(engine.status().actions.length, 0);
  } finally {
    store.close();
  }
});

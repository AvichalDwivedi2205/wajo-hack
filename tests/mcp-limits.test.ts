import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/server/mcp.ts";
import { Engine } from "../src/core/engine.ts";
import { Store } from "../src/core/store.ts";
import { FixtureAdapter } from "../src/companion/adapter.ts";
import { MAX_MCP_RESULT_BYTES } from "../src/shared/limits.ts";

test("oversized MCP evidence returns a bounded error without losing subsequent status or local evidence", async () => {
  const store = new Store();
  const engine = new Engine(store, new FixtureAdapter(store));
  engine.grantPermission();
  store.data.fixture.devices = Array.from({ length: 128 }, (_, i) => ({
    id: String(i),
    name: "\u0001".repeat(256),
    transport: "\u0001".repeat(64),
    alive: true,
    muted: false,
  }));
  store.data.fixture.outputId = "0";
  const server = createMcpServer(engine);
  const client = new Client({
    name: "synthetic-result-budget-test",
    version: "1",
  });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    for (const request of [
      { name: "fo_fix_inspect_output", arguments: {} },
      {
        name: "fo_fix_propose_repair",
        arguments: { recipe: "switch-output", deviceId: "1" },
      },
    ]) {
      const result = await client.callTool(request);
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /RESULT_TOO_LARGE/);
      assert.ok(
        Buffer.byteLength(JSON.stringify(result)) < MAX_MCP_RESULT_BYTES,
      );
    }
    assert.equal(engine.status().plans.length, 1);
    const status = await client.callTool({
      name: "fo_fix_status",
      arguments: {},
    });
    assert.notEqual(status.isError, true);
    assert.ok(
      Buffer.byteLength(JSON.stringify(status)) <= MAX_MCP_RESULT_BYTES,
    );
  } finally {
    await client.close();
    await server.close();
    store.close();
  }
});

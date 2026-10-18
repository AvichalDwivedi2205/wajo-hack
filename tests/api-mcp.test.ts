import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { request as rawRequest, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createApp } from "../src/server/app.ts";
import { Engine } from "../src/core/engine.ts";
import { Store } from "../src/core/store.ts";
import { FixtureAdapter } from "../src/companion/adapter.ts";
import type { Plan } from "../src/shared/types.ts";

const port = 14311;
const origin = `http://127.0.0.1:${port}`;
const store = new Store();
const engine = new Engine(store, new FixtureAdapter(store));
let server: Server;
before(async () => {
  const { app, errors } = createApp(engine, port);
  app.use(errors);
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
});
after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  store.close();
});
async function request(
  path: string,
  data = {},
  extra: Record<string, string> = {},
  method = "POST",
) {
  return fetch(`${origin}/api/${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...extra },
    ...(method === "GET" ? {} : { body: JSON.stringify(data) }),
  });
}
function rawStatus(headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const req = rawRequest(
      `${origin}/api/permission`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", reject);
    req.end("{}");
  });
}
test("human permission endpoint requires exact local Origin; foreign Host and Origin rejected", async () => {
  assert.equal((await request("permission")).status, 403);
  assert.equal(
    (await request("permission", {}, { Origin: "https://attacker.invalid" }))
      .status,
    403,
  );
  assert.equal(
    await rawStatus({ Origin: origin, Host: "attacker.invalid" }),
    403,
  );
  assert.equal(
    await rawStatus({ Origin: origin, "Sec-Fetch-Site": "cross-site" }),
    403,
  );
  assert.equal(engine.status().permission.active, false);
  assert.equal(
    (await request("permission", {}, { Origin: origin })).status,
    200,
  );
});
test("API validates strict schema and rejects arbitrary commands", async () => {
  for (const body of [
    { recipe: "shell", command: "echo pwned" },
    { recipe: "switch-output", deviceId: "fixture-speakers", approval: true },
    { recipe: "switch-output" },
    { recipe: "unmute-output", deviceId: "fixture-headphones" },
  ]) {
    assert.equal((await request("plans", body)).status, 400);
  }
  assert.equal((await request("plans/not-a-uuid/execute")).status, 400);
});
test("oversized requests are rejected without echoing input or taking down the companion", async () => {
  const response = await request("plans", {
    recipe: "switch-output",
    deviceId: "x".repeat(20 * 1024),
  });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    code: "REQUEST_TOO_LARGE",
    message: "Requests are limited to 16 KiB.",
  });
  assert.equal((await request("status", {}, {}, "GET")).status, 200);
});
test("HTTP approval cannot be spoofed through execute arguments or missing local review Origin", async () => {
  const p = (await (
    await request("plans", {
      recipe: "switch-output",
      deviceId: "fixture-speakers",
    })
  ).json()) as Plan;
  assert.equal(
    (await request(`plans/${p.id}/execute`, { approved: true })).status,
    400,
  );
  assert.equal((await request(`plans/${p.id}/execute`)).status, 403);
  assert.equal(
    (await request(`plans/${p.id}/approve`, { digest: p.digest })).status,
    403,
  );
  assert.equal(
    (
      await request(
        `plans/${p.id}/approve`,
        { digest: p.digest },
        { Origin: origin },
      )
    ).status,
    200,
  );
  const action = await (await request(`plans/${p.id}/execute`)).json();
  assert.equal(action.state, "succeeded");
});
test("real MCP SDK client lists bounded tools; no grant, approve, terminal or security tools exist", async () => {
  const client = new Client({ name: "fo-fix-protocol-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)),
    );
    assert.match(client.getInstructions()!, /synthetic/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "fo_fix_execute_approved",
      "fo_fix_inspect_output",
      "fo_fix_propose_repair",
      "fo_fix_propose_undo",
      "fo_fix_status",
    ]);
    for (const t of tools)
      assert.equal(t.inputSchema.additionalProperties, false);
    const state = await client.callTool({
      name: "fo_fix_status",
      arguments: {},
    });
    assert.equal(state.isError, undefined);
    assert.equal(
      (state.structuredContent as { result: { mode: string } }).result.mode,
      "fixture",
    );
    const unknown = await client.callTool({
      name: "approve",
      arguments: { approved: true },
    });
    assert.equal(unknown.isError, true);
    const bad = await client.callTool({
      name: "fo_fix_propose_repair",
      arguments: { recipe: "shell" },
    });
    assert.equal(bad.isError, true);
    const ambiguousTarget = await client.callTool({
      name: "fo_fix_propose_repair",
      arguments: { recipe: "unmute-output", deviceId: "fixture-headphones" },
    });
    assert.equal(ambiguousTarget.isError, true);
  } finally {
    await client.close();
  }
});
test("MCP proposal cannot execute until human review; verification and history are shared", async () => {
  const client = new Client({
    name: "fo-integration-contract-test",
    version: "1",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)),
    );
    const proposed = await client.callTool({
      name: "fo_fix_propose_repair",
      arguments: { recipe: "switch-output", deviceId: "fixture-headphones" },
    });
    const p = (proposed.structuredContent as { result: Plan }).result;
    assert.equal(
      (
        await client.callTool({
          name: "fo_fix_execute_approved",
          arguments: { planId: p.id },
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await request(
          `plans/${p.id}/approve`,
          { digest: p.digest },
          { Origin: origin },
        )
      ).status,
      200,
    );
    const execution = await client.callTool({
      name: "fo_fix_execute_approved",
      arguments: { planId: p.id },
    });
    assert.equal(
      (execution.structuredContent as { result: { state: string } }).result
        .state,
      "succeeded",
    );
    assert.equal(engine.status().actions[0].planId, p.id);
    assert.equal(
      (
        await client.callTool({
          name: "fo_fix_execute_approved",
          arguments: { planId: p.id },
        })
      ).isError,
      true,
    );
    await request("permission", {}, { Origin: origin }, "DELETE");
    assert.equal(
      (await client.callTool({ name: "fo_fix_inspect_output", arguments: {} }))
        .isError,
      true,
    );
  } finally {
    await client.close();
  }
});
test("stdio bridge speaks MCP and shares the running companion rather than creating independent approvals", async () => {
  const client = new Client({ name: "fo-fix-stdio-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/server/stdio.ts"],
    env: {
      ...(Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) =>
            value !== undefined && ["PATH", "NODE_PATH"].includes(key),
        ),
      ) as Record<string, string>),
      FO_FIX_PORT: String(port),
    },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    assert.match(client.getInstructions()!, /synthetic/);
    assert.match(
      client.getInstructions()!,
      /cannot grant permission or approve/i,
    );
    assert.equal((await client.listTools()).tools.length, 5);
    const state = await client.callTool({
      name: "fo_fix_status",
      arguments: {},
    });
    const result = (
      state.structuredContent as {
        result: {
          actions: unknown[];
          permission: { active: boolean };
          history: { redacted: boolean; actionCount: number };
        };
      }
    ).result;
    assert.equal(result.actions.length, 0);
    assert.equal(result.history.actionCount, engine.status().actions.length);
    assert.equal(result.history.redacted, true);
    assert.equal(result.permission.active, false);
  } finally {
    await client.close();
  }
});

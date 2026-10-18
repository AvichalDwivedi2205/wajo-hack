import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/store.ts";

test(
  "SIGTERM gracefully persists revocation, invalidates pending plans and releases the real server journal",
  { timeout: 15_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "fo-fix-shutdown-"));
    const database = join(dir, "fixture.sqlite");
    const origin = "http://127.0.0.1:14312";
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/server/main.ts", "--production"],
      {
        env: {
          PATH: process.env.PATH,
          FO_FIX_PORT: "14312",
          FO_FIX_DATA: database,
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Companion did not become ready")),
          8_000,
        );
        const read = (chunk: Buffer) => {
          if (chunk.toString().includes("Fo Fix: http://127.0.0.1:14312")) {
            clearTimeout(timeout);
            child.stderr.off("data", read);
            resolve();
          }
        };
        child.stderr.on("data", read);
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("Companion exited before ready"));
        });
      });
      const headers = { Origin: origin, "Content-Type": "application/json" };
      assert.equal(
        (
          await fetch(`${origin}/api/permission`, {
            method: "POST",
            headers,
            body: "{}",
          })
        ).status,
        200,
      );
      const proposed = await fetch(`${origin}/api/plans`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          recipe: "switch-output",
          deviceId: "fixture-speakers",
        }),
      });
      assert.equal(proposed.status, 200);
      child.kill("SIGTERM");
      const result = await exited;
      assert.equal(result.code, 0);
      assert.equal(result.signal, null);
      const reopened = new Store(database);
      try {
        assert.equal(reopened.data.grant, null);
        assert.equal(reopened.data.plans[0].status, "denied");
        assert.equal(reopened.data.events.at(-1)?.kind, "companion.stopping");
      } finally {
        reopened.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

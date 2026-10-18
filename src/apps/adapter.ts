import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { invariant } from "../core/errors.ts";
import {
  appFact,
  appId,
  supportedApps,
  type AppFact,
  type AppId,
} from "./contracts.ts";

export interface AppAdapter {
  source: "fixture" | "macos";
  inspect(id: AppId): Promise<AppFact>;
  open(id: AppId, identity: string): Promise<void>;
}
const run = promisify(execFile);
export class MacAppAdapter implements AppAdapter {
  readonly source = "macos" as const;
  constructor(private helper: string) {
    invariant(
      process.platform === "darwin" && helper.startsWith("/"),
      "APP_HELPER_REQUIRED",
      "Use the fixed native app helper on macOS.",
      400,
    );
  }
  private async call(
    command: "inspect" | "open",
    id: AppId,
    identity?: string,
  ) {
    appId.parse(id);
    const result = await run(
      this.helper,
      [command, id, ...(identity === undefined ? [] : [identity])],
      {
        timeout: 15_000,
        maxBuffer: 32 * 1024,
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    const fact = appFact.parse(JSON.parse(result.stdout));
    invariant(
      fact.id === id &&
        fact.bundleId === supportedApps[id].bundleId &&
        fact.name === supportedApps[id].name,
      "INVALID_APP_RESULT",
      "The native helper returned a different application.",
      502,
    );
    return fact;
  }
  inspect(id: AppId) {
    return this.call("inspect", id);
  }
  async open(id: AppId, identity: string) {
    await this.call("open", id, identity);
  }
}

// Explicitly synthetic adapter for isolated tests and --apps-demo only.
export class FixtureAppAdapter implements AppAdapter {
  readonly source = "fixture" as const;
  facts = Object.fromEntries(
    Object.entries(supportedApps).map(([id, app]) => [
      id,
      {
        id,
        ...app,
        installed: true,
        identity: `synthetic:${app.bundleId}:1`,
        running: false,
        active: false,
      },
    ]),
  ) as Record<AppId, AppFact>;
  async inspect(id: AppId) {
    return structuredClone(this.facts[appId.parse(id)]);
  }
  async open(id: AppId) {
    for (const fact of Object.values(this.facts)) fact.active = false;
    this.facts[appId.parse(id)].running = true;
    this.facts[id].active = true;
  }
}

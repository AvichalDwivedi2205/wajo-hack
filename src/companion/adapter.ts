import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Change, DeviceState, Mode } from "../shared/types.ts";
import type { Store } from "../core/store.ts";
import { invariant } from "../core/errors.ts";

export interface DeviceAdapter {
  mode: Mode;
  inspect(): Promise<DeviceState>;
  apply(change: Change): Promise<void>;
}
export class FixtureAdapter implements DeviceAdapter {
  readonly mode = "fixture" as const;
  constructor(private store: Store) {}
  async inspect() {
    return structuredClone(this.store.data.fixture);
  }
  async apply(change: Change) {
    const state = this.store.data.fixture;
    const device = state.devices.find((d) => d.id === change.deviceId);
    invariant(
      device?.alive,
      "DEVICE_UNAVAILABLE",
      "The selected output is no longer available.",
    );
    if (change.kind === "set-output") state.outputId = device.id;
    else device.muted = change.muted;
    this.store.save();
  }
}
const deviceSchema = z
  .object({
    id: z.string().regex(/^\d+$/),
    name: z.string().max(256),
    transport: z.string().max(64),
    alive: z.boolean(),
    // Older helper binaries omit nil Optional values. Treat missing mute as
    // unsupported, never as unmuted or permission to write that control.
    muted: z
      .boolean()
      .nullable()
      .optional()
      .transform((value) => value ?? null),
  })
  .strict();
const stateSchema = z
  .object({
    outputId: z.string().regex(/^\d+$/),
    devices: z.array(deviceSchema).max(128),
  })
  .strict();
const execFileAsync = promisify(execFile);
export function parseNativeState(value: unknown): DeviceState {
  return stateSchema.parse(value);
}
export class MacOSAdapter implements DeviceAdapter {
  readonly mode = "macos" as const;
  constructor(private helperPath: string) {
    invariant(
      process.platform === "darwin",
      "UNSUPPORTED_PLATFORM",
      "The real companion requires macOS. Use fixture mode in the cloud.",
      400,
    );
    invariant(
      helperPath.startsWith("/"),
      "HELPER_PATH",
      "The native helper must have an absolute path.",
      400,
    );
  }
  private async run(args: string[]) {
    // Fixed executable and enumerated arguments only; no shell, script, command text or sudo.
    const result = await execFileAsync(this.helperPath, args, {
      timeout: 5000,
      maxBuffer: 128 * 1024,
      env: { PATH: "/usr/bin:/bin" },
    });
    return result.stdout;
  }
  async inspect(): Promise<DeviceState> {
    return parseNativeState(JSON.parse(await this.run(["inspect"])));
  }
  async apply(change: Change) {
    invariant(
      /^\d+$/.test(change.deviceId),
      "INVALID_DEVICE",
      "Invalid CoreAudio device identifier.",
      400,
    );
    await this.run(
      change.kind === "set-output"
        ? ["set-output", change.deviceId]
        : ["set-mute", change.deviceId, String(change.muted)],
    );
  }
}

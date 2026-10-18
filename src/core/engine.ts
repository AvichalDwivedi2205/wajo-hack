import { createHash, randomUUID } from "node:crypto";
import type {
  Action,
  AuditEvent,
  AppStatus,
  Change,
  DeviceState,
  Plan,
  Recipe,
  Snapshot,
} from "../shared/types.ts";
import type { DeviceAdapter } from "../companion/adapter.ts";
import { Store } from "./store.ts";
import { FixError, invariant } from "./errors.ts";
import { MAX_AGENT_STATUS_BYTES } from "../shared/limits.ts";

export function revision(state: DeviceState) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        outputId: state.outputId,
        devices: [...state.devices]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map(({ id, name, transport, alive, muted }) => ({
            id,
            name,
            transport,
            alive,
            muted,
          })),
      }),
    )
    .digest("hex");
}
export class Engine {
  private queue: Promise<unknown> = Promise.resolve();
  private permissionGeneration = 0;
  private stopping = false;
  constructor(
    readonly store: Store,
    readonly adapter: DeviceAdapter,
    private clock: () => number = Date.now,
  ) {
    // A process interruption must never turn a consumed approval into a retry.
    for (const action of store.data.actions.filter(
      (a) => a.state === "executing",
    )) {
      action.state = "uncertain";
      action.error =
        "Companion stopped during this change. Inspect again; no automatic retry was attempted.";
      this.audit("execution.interrupted", action.id, action.error);
    }
    // Device access is a per-process lease. Restart never silently restores it.
    store.data.grant = null;
    this.invalidatePlans(
      "Companion restarted. Review a fresh proposal after allowing inspection again.",
    );
    store.save();
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private audit(kind: string, subjectId: string | undefined, detail: string) {
    this.store.data.events.push({
      id: randomUUID(),
      at: this.now(),
      kind,
      subjectId,
      detail,
    });
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private requirePermission() {
    invariant(
      !this.stopping,
      "COMPANION_STOPPING",
      "The companion is stopping. No new device operations are accepted.",
      503,
    );
    invariant(
      this.permissionActive(),
      "PERMISSION_REQUIRED",
      "Allow a temporary sound-output inspection in the local Fo Reach interface first.",
      403,
    );
  }
  private permissionActive() {
    return (
      !!this.store.data.grant &&
      Date.parse(this.store.data.grant.expiresAt) > this.clock()
    );
  }
  status(audience: "local" | "agent" = "local"): AppStatus {
    const redacted = audience === "agent" && !this.permissionActive();
    const agent = audience === "agent";
    const status: AppStatus = {
      name: "Fo Fix",
      mode: this.adapter.mode,
      companion: this.adapter.mode === "fixture" ? "fixture" : "local",
      lifecycle: this.stopping ? "stopping" : "ready",
      permission: {
        active: this.permissionActive(),
        expiresAt: this.store.data.grant?.expiresAt,
        scope:
          "Output device names, availability, selected output, mute state and locally recorded repair evidence. No microphone, audio recording, personal files or network settings.",
      },
      capabilities: [
        "inspect-output",
        "switch-output",
        "unmute-output",
        "verify",
        "undo",
      ],
      fo: {
        connected: null,
        status:
          "Fo registration is managed in Wajo. Confirm this connection with a successful live Fo tool call; this companion cannot verify the account registration.",
      },
      history: {
        redacted,
        ...(agent ? { truncated: false } : {}),
        actionCount: this.store.data.actions.length,
        planCount: this.store.data.plans.length,
        eventCount: this.store.data.events.length,
      },
      actions: redacted
        ? []
        : this.store.data.actions.slice(agent ? -20 : 0).reverse(),
      plans: redacted
        ? []
        : this.store.data.plans.slice(agent ? -20 : 0).reverse(),
      events: redacted
        ? []
        : this.store.data.events.slice(agent ? -40 : 0).reverse(),
    };
    if (agent && !redacted) {
      // Device names and snapshots vary in size. Counts alone cannot bound a
      // result which MCP serializes as both text and structured content.
      const collections = [status.actions, status.plans, status.events];
      while (
        Buffer.byteLength(JSON.stringify(status)) > MAX_AGENT_STATUS_BYTES
      ) {
        const oldest = collections
          .filter((items) => items.length)
          .sort((a, b) => {
            const timestamp = (item: Action | Plan | AuditEvent) =>
              "startedAt" in item
                ? item.startedAt
                : "createdAt" in item
                  ? item.createdAt
                  : item.at;
            return timestamp(a.at(-1)!).localeCompare(timestamp(b.at(-1)!));
          })[0];
        if (!oldest) break;
        oldest.pop();
      }
      status.history.truncated =
        status.actions.length < status.history.actionCount ||
        status.plans.length < status.history.planCount ||
        status.events.length < status.history.eventCount;
    }
    return structuredClone(status);
  }
  grantPermission() {
    invariant(
      !this.stopping,
      "COMPANION_STOPPING",
      "The companion is stopping. Inspection cannot be enabled.",
      503,
    );
    this.permissionGeneration++;
    this.invalidatePlans(
      "Inspection permission was replaced. Review a fresh proposal.",
    );
    this.store.data.grant = {
      expiresAt: new Date(this.clock() + 20 * 60_000).toISOString(),
    };
    this.audit(
      "permission.granted",
      undefined,
      "Sound-output inspection and recorded repair evidence allowed for 20 minutes. Each write still requires a separate approval.",
    );
    this.store.save();
    return this.status();
  }
  revokePermission() {
    this.permissionGeneration++;
    this.store.data.grant = null;
    this.invalidatePlans("Device access was revoked.");
    this.audit(
      "permission.revoked",
      undefined,
      "Device access revoked and outstanding plans invalidated.",
    );
    this.store.save();
    return this.status();
  }
  private invalidatePlans(reason: string) {
    for (const plan of this.store.data.plans) {
      if (plan.status === "pending" || plan.status === "approved") {
        plan.status = "denied";
        this.audit("plan.invalidated", plan.id, reason);
      }
    }
  }
  async shutdown() {
    if (!this.stopping) {
      this.stopping = true;
      this.permissionGeneration++;
      this.store.data.grant = null;
      this.invalidatePlans("Companion is stopping.");
      this.audit(
        "companion.stopping",
        undefined,
        "New operations blocked. An already-started write will finish verification and journaling before the database closes.",
      );
      this.store.save();
    }
    await this.queue;
  }
  private async capture(): Promise<Snapshot> {
    const state = await this.adapter.inspect();
    return {
      ...state,
      revision: revision(state),
      capturedAt: this.now(),
      source: this.adapter.mode,
    };
  }
  private async captureAllowed() {
    this.requirePermission();
    const generation = this.permissionGeneration;
    const snapshot = await this.capture();
    this.requirePermission();
    invariant(
      generation === this.permissionGeneration,
      "PERMISSION_CHANGED",
      "Inspection permission changed during this read. Start a fresh inspection.",
      403,
    );
    return snapshot;
  }
  inspect() {
    return this.serial(async () => {
      const snapshot = await this.captureAllowed();
      this.audit(
        "inspection.completed",
        undefined,
        `${this.adapter.mode} output state inspected; ${snapshot.devices.length} outputs.`,
      );
      this.store.save();
      return snapshot;
    });
  }
  propose(recipe: Recipe, deviceId?: string) {
    return this.serial(async () => {
      const before = await this.captureAllowed();
      let change: Change;
      if (recipe === "switch-output") {
        const device = before.devices.find((d) => d.id === deviceId);
        invariant(
          device?.alive,
          "DEVICE_UNAVAILABLE",
          "Choose an available output.",
        );
        invariant(
          before.outputId !== device.id,
          "NO_CHANGE",
          "That output is already selected.",
        );
        change = { kind: "set-output", deviceId: device.id };
      } else {
        invariant(
          recipe === "unmute-output",
          "UNSUPPORTED_RECIPE",
          "This repair is outside the supported scope.",
          400,
        );
        invariant(
          deviceId === undefined,
          "INVALID_REQUEST",
          "Unmute targets the active output. Do not specify a different device.",
          400,
        );
        const device = before.devices.find((d) => d.id === before.outputId);
        invariant(
          device?.alive && device.muted !== null,
          "UNSUPPORTED_CONTROL",
          "This output does not expose a supported mute control.",
        );
        invariant(
          device.muted,
          "NO_CHANGE",
          "The selected output is already unmuted.",
        );
        change = { kind: "set-mute", deviceId: device.id, muted: false };
      }
      return this.createPlan(before, change, "repair");
    });
  }
  private createPlan(
    before: Snapshot,
    change: Change,
    direction: "repair" | "undo",
    sourceActionId?: string,
  ) {
    const expected: DeviceState = {
      outputId: before.outputId,
      devices: structuredClone(before.devices),
    };
    const device = expected.devices.find((d) => d.id === change.deviceId)!;
    invariant(
      device?.alive,
      "DEVICE_UNAVAILABLE",
      "The original output is no longer available.",
    );
    const previousName =
      before.devices.find((d) => d.id === before.outputId)?.name ??
      "current output";
    if (change.kind === "set-output") expected.outputId = change.deviceId;
    else {
      invariant(
        device.muted !== null,
        "UNSUPPORTED_CONTROL",
        "Mute control is no longer available.",
      );
      device.muted = change.muted;
    }
    const effect =
      change.kind === "set-output"
        ? `Switch the default sound output from ${previousName} to ${device.name}.`
        : `${change.muted ? "Mute" : "Unmute"} ${device.name}.`;
    const plan: Plan = {
      id: randomUUID(),
      digest: "",
      title:
        change.kind === "set-output"
          ? `Use ${device.name}`
          : `${change.muted ? "Mute" : "Unmute"} ${device.name}`,
      explanation:
        direction === "undo"
          ? "Restore the setting captured immediately before this repair. Other device state must still match the verified result."
          : change.kind === "set-output"
            ? "Sound goes to the selected default output. This changes only that selection, to the output you chose."
            : "The selected output reports that it is muted. Unmuting changes only its mute setting.",
      effect,
      risk:
        change.kind === "set-output"
          ? "New audio follows this output. Some apps keep their own output choice. Its existing volume and mute state stay as they are."
          : "Audio may become audible at the existing volume. Volume is not changed.",
      change,
      before,
      expected,
      createdAt: this.now(),
      expiresAt: new Date(this.clock() + 5 * 60_000).toISOString(),
      status: "pending",
      direction,
      sourceActionId,
    };
    plan.digest = createHash("sha256")
      .update(JSON.stringify(plan))
      .digest("hex");
    this.store.data.plans.push(plan);
    this.audit("plan.proposed", plan.id, `${direction}: ${effect}`);
    this.store.save();
    return structuredClone(plan);
  }
  approve(planId: string, digest: string) {
    return this.serial(async () => {
      this.requirePermission();
      const plan = this.findPlan(planId);
      invariant(
        plan.status === "pending",
        "PLAN_NOT_PENDING",
        "This plan has already been handled.",
      );
      invariant(
        plan.digest === digest,
        "PLAN_MISMATCH",
        "Approval does not match the displayed plan.",
      );
      invariant(
        Date.parse(plan.expiresAt) > this.clock(),
        "PLAN_EXPIRED",
        "This proposal expired. Inspect and propose again.",
      );
      const current = await this.captureAllowed();
      invariant(
        current.revision === plan.before.revision,
        "STATE_CHANGED",
        "Device state changed. Inspect and review a fresh proposal.",
      );
      this.requirePermission();
      invariant(
        plan.status === "pending",
        "PLAN_NOT_PENDING",
        "This plan was revoked during inspection.",
      );
      invariant(
        Date.parse(plan.expiresAt) > this.clock(),
        "PLAN_EXPIRED",
        "This proposal expired during inspection.",
      );
      plan.status = "approved";
      plan.approvedAt = this.now();
      this.audit(
        "plan.approved",
        plan.id,
        "Specific plan approved in the local human interface.",
      );
      this.store.save();
      return structuredClone(plan);
    });
  }
  async deny(planId: string) {
    // Cancellation must run immediately, including while an approval or
    // execution is awaiting its pre-write read. It must not queue behind it.
    const plan = this.findPlan(planId);
    invariant(
      plan.status === "pending" || plan.status === "approved",
      "PLAN_CLOSED",
      "This plan is already closed.",
    );
    plan.status = "denied";
    this.audit("plan.denied", plan.id, "Plan declined. No changes made.");
    this.store.save();
    return structuredClone(plan);
  }
  private findPlan(id: string) {
    const plan = this.store.data.plans.find((p) => p.id === id);
    invariant(plan, "NOT_FOUND", "Plan not found.", 404);
    return plan;
  }
  execute(planId: string) {
    return this.serial(async () => {
      this.requirePermission();
      const plan = this.findPlan(planId);
      invariant(
        plan.status === "approved",
        "APPROVAL_REQUIRED",
        "This exact plan needs approval in the local Fo Reach interface.",
        403,
      );
      invariant(
        Date.parse(plan.expiresAt) > this.clock(),
        "PLAN_EXPIRED",
        "This approval expired. Propose again.",
      );
      const before = await this.captureAllowed();
      // A human can revoke while the native read is in flight. Recheck immediately
      // before consuming approval; once adapter.apply begins an OS write cannot be cancelled.
      this.requirePermission();
      invariant(
        plan.status === "approved",
        "APPROVAL_REQUIRED",
        "This plan was revoked during inspection.",
        403,
      );
      invariant(
        Date.parse(plan.expiresAt) > this.clock(),
        "PLAN_EXPIRED",
        "This approval expired during inspection.",
      );
      if (before.revision !== plan.before.revision) {
        plan.status = "denied";
        this.audit(
          "execution.blocked",
          plan.id,
          "Device state changed after approval.",
        );
        this.store.save();
        throw new FixError(
          "STATE_CHANGED",
          "Device state changed after approval. Review a fresh proposal.",
        );
      }
      if (plan.direction === "undo") {
        const source = this.store.data.actions.find(
          (a) => a.id === plan.sourceActionId,
        );
        invariant(
          source?.state === "succeeded" &&
            source.direction === "repair" &&
            !source.undoneBy,
          "UNDO_UNAVAILABLE",
          "The source repair has already been undone or is no longer eligible.",
        );
      }
      const action: Action = {
        id: randomUUID(),
        planId,
        title: plan.title,
        source: this.adapter.mode,
        direction: plan.direction,
        sourceActionId: plan.sourceActionId,
        state: "executing",
        startedAt: this.now(),
        before,
        change: plan.change,
      };
      plan.status = "consumed";
      // Retire all other authorizations before every write, even if a later
      // operation returns the device to an identical state (the ABA case).
      this.invalidatePlans(
        "Another change started. Inspect and review a fresh proposal.",
      );
      this.store.data.actions.push(action);
      this.audit("execution.started", action.id, plan.effect);
      this.store.save(); // Write-ahead journal + consume approval BEFORE touching the adapter.
      try {
        await this.adapter.apply(plan.change);
        const after = await this.capture();
        action.after = after;
        const passed = after.revision === revision(plan.expected);
        action.verification = {
          status: passed ? "passed" : "failed",
          expected: plan.effect,
          observed: passed
            ? "A fresh device read matches the approved setting. Audibility still needs a human check."
            : "A fresh device read did not match the approved result. No automatic retry was attempted.",
          checkedAt: this.now(),
        };
        action.state = passed ? "succeeded" : "failed";
        if (passed && plan.direction === "undo") {
          const source = this.store.data.actions.find(
            (a) => a.id === plan.sourceActionId,
          );
          if (source) source.undoneBy = action.id;
        }
      } catch {
        action.state = "uncertain";
        action.error =
          "The device change or verification could not complete. Inspect again before deciding what to do.";
        action.verification = {
          status: "unavailable",
          expected: plan.effect,
          observed: action.error,
          checkedAt: this.now(),
        };
        // Keep a post-error read when possible, without claiming the attempted operation succeeded.
        try {
          action.after = await this.capture();
        } catch {
          /* Device can be disconnected. */
        }
      }
      action.completedAt = this.now();
      this.audit(
        `execution.${action.state}`,
        action.id,
        action.verification?.observed ?? "Interrupted",
      );
      this.store.save();
      return structuredClone(action);
    });
  }
  proposeUndo(actionId: string) {
    return this.serial(async () => {
      this.requirePermission();
      const action = this.store.data.actions.find((a) => a.id === actionId);
      invariant(action, "NOT_FOUND", "Action not found.", 404);
      invariant(
        action.direction === "repair" &&
          !action.undoneBy &&
          action.state === "succeeded" &&
          action.after,
        "UNDO_UNAVAILABLE",
        "Only a verified repair that has not been undone can be reversed.",
      );
      const current = await this.captureAllowed();
      invariant(
        current.revision === action.after.revision,
        "STATE_CHANGED",
        "Device state changed since this repair. Undo would overwrite a newer choice, so it was blocked.",
      );
      const change: Change =
        action.change.kind === "set-output"
          ? { kind: "set-output", deviceId: action.before.outputId }
          : {
              kind: "set-mute",
              deviceId: action.change.deviceId,
              muted: action.before.devices.find(
                (d) => d.id === action.change.deviceId,
              )!.muted!,
            };
      return this.createPlan(current, change, "undo", action.id);
    });
  }
}

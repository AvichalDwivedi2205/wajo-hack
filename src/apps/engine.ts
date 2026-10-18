import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../core/store.ts";
import { invariant } from "../core/errors.ts";
import {
  appId,
  supportedApps,
  type AppAgent,
  type AppId,
  type AppPlan,
  type AppAction,
} from "./contracts.ts";
import type { AppAdapter } from "./adapter.ts";

export class AppEngine implements AppAgent {
  private lease = 0;
  private generation = 0;
  private stopping = false;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private store: Store,
    readonly adapter: AppAdapter,
    private clock = Date.now,
  ) {
    store.data.apps ??= { plans: [], actions: [] };
    this.invalidate();
    for (const action of this.data.actions)
      if (action.state === "executing") {
        action.state = "uncertain";
        action.observed =
          "Companion restarted during app opening. Inspect the Mac; no automatic retry.";
      }
    store.save();
  }
  private get data() {
    return this.store.data.apps!;
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private invalidate() {
    for (const p of this.data.plans)
      if (p.status === "pending" || p.status === "approved")
        p.status = "denied";
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  private allowed() {
    invariant(
      !this.stopping && this.lease > this.clock(),
      "APP_PERMISSION_REQUIRED",
      "Allow supported-app inspection in the local Mac companion first.",
      403,
    );
  }
  status() {
    return structuredClone({
      enabled: true,
      authority: "here",
      source: this.adapter.source,
      permission: {
        active: !this.stopping && this.lease > this.clock(),
        expiresAt: this.lease ? new Date(this.lease).toISOString() : undefined,
      },
      plans: [...this.data.plans].reverse(),
      actions: [...this.data.actions].reverse(),
    });
  }
  grant() {
    invariant(
      !this.stopping,
      "COMPANION_STOPPING",
      "The companion is stopping.",
      503,
    );
    this.generation++;
    this.invalidate();
    this.lease = this.clock() + 20 * 60_000;
    this.store.save();
    return this.status();
  }
  revoke() {
    this.generation++;
    this.lease = 0;
    this.invalidate();
    this.store.save();
    return this.status();
  }
  private async capture(id: AppId) {
    this.allowed();
    const generation = this.generation;
    const fact = await this.adapter.inspect(appId.parse(id));
    this.allowed();
    invariant(
      generation === this.generation,
      "APP_PERMISSION_CHANGED",
      "App permission changed during inspection.",
      403,
    );
    return fact;
  }
  inspect() {
    return this.serial(async () => {
      const generation = this.generation;
      const apps = [];
      for (const id of appId.options) apps.push(await this.capture(id));
      invariant(
        generation === this.generation,
        "APP_PERMISSION_CHANGED",
        "App permission changed during inspection.",
        403,
      );
      return {
        source: this.adapter.source,
        apps,
        plans: this.data.plans.slice(-20).reverse(),
        actions: this.data.actions.slice(-20).reverse(),
      };
    });
  }
  propose(id: AppId) {
    return this.serial(async () => {
      const fact = await this.capture(id);
      invariant(
        fact.installed && fact.identity,
        "APP_NOT_INSTALLED",
        `${supportedApps[id].name} is not installed. No app was downloaded or substituted.`,
        409,
      );
      invariant(
        this.data.plans.filter(
          (p) =>
            (p.status === "pending" || p.status === "approved") &&
            Date.parse(p.expiresAt) > this.clock(),
        ).length < 20,
        "APP_PLAN_LIMIT",
        "Review or decline outstanding app proposals before creating more.",
        429,
      );
      const plan: AppPlan = {
        id: randomUUID(),
        digest: "",
        appId: id,
        title: `Open ${supportedApps[id].name}`,
        effect: `Open ${supportedApps[id].name} and bring it to the front.`,
        risk: "The app may restore its existing windows or resume its own prior behavior. This action does not select or play music, open a URL/file, change volume, or close another app. There is no automatic undo.",
        identity: fact.identity,
        createdAt: this.now(),
        expiresAt: new Date(this.clock() + 5 * 60_000).toISOString(),
        status: "pending",
      };
      plan.digest = createHash("sha256")
        .update(JSON.stringify(plan))
        .digest("hex");
      this.data.plans.push(plan);
      this.store.save();
      return structuredClone(plan);
    });
  }
  private find(id: string) {
    const plan = this.data.plans.find((p) => p.id === id);
    invariant(plan, "NOT_FOUND", "App plan not found.", 404);
    return plan;
  }
  private live(plan: AppPlan, status: "pending" | "approved") {
    this.allowed();
    invariant(
      plan.status === status,
      "APP_APPROVAL_REQUIRED",
      "This exact app plan needs fresh local approval.",
      403,
    );
    invariant(
      Date.parse(plan.expiresAt) > this.clock(),
      "APP_PLAN_EXPIRED",
      "This app proposal expired. Propose again.",
    );
  }
  private async unchanged(plan: AppPlan) {
    const fact = await this.capture(plan.appId);
    invariant(
      fact.installed && fact.identity === plan.identity,
      "APP_CHANGED",
      "The installed app changed. Review a fresh proposal.",
    );
  }
  approve(id: string, digest: string) {
    return this.serial(async () => {
      const plan = this.find(id);
      this.live(plan, "pending");
      invariant(
        plan.digest === digest,
        "PLAN_MISMATCH",
        "Approval does not match the displayed app plan.",
      );
      await this.unchanged(plan);
      this.live(plan, "pending");
      plan.status = "approved";
      this.store.save();
      return structuredClone(plan);
    });
  }
  deny(id: string) {
    const plan = this.find(id);
    invariant(
      plan.status === "pending" || plan.status === "approved",
      "PLAN_CLOSED",
      "This plan is already closed.",
    );
    plan.status = "denied";
    this.store.save();
    return structuredClone(plan);
  }
  execute(id: string) {
    return this.serial(async () => {
      const plan = this.find(id);
      this.live(plan, "approved");
      await this.unchanged(plan);
      this.live(plan, "approved");
      const action: AppAction = {
        id: randomUUID(),
        planId: id,
        appId: plan.appId,
        source: this.adapter.source,
        state: "executing",
        startedAt: this.now(),
        observed: "Opening the approved app.",
      };
      plan.status = "consumed";
      this.invalidate();
      this.data.actions.push(action);
      const generation = this.generation;
      this.store.save(); // Consume and journal before the native launch; never retry automatically.
      try {
        await this.adapter.open(plan.appId, plan.identity);
        this.allowed();
        invariant(
          generation === this.generation,
          "APP_PERMISSION_CHANGED",
          "App permission changed during opening.",
          403,
        );
        const after = await this.capture(plan.appId);
        action.after = after;
        invariant(
          after.installed &&
            after.identity === plan.identity &&
            after.running &&
            after.active,
          "APP_VERIFICATION_FAILED",
          "The approved app was not verified running in front.",
        );
        action.state = "succeeded";
        action.observed =
          this.adapter.source === "macos"
            ? `${supportedApps[plan.appId].name} is running and is the frontmost app. Playback was not verified.`
            : "Synthetic app-opening state verified. No native app was opened.";
      } catch {
        action.state = "uncertain";
        action.observed =
          "Opening or verification did not complete. Check the Mac before a fresh proposal; no automatic retry.";
      }
      action.completedAt = this.now();
      this.store.save();
      return structuredClone(action);
    });
  }
  async shutdown() {
    this.stopping = true;
    this.revoke();
    await this.queue;
  }
}

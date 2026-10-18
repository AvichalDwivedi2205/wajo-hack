import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Express } from "express";
import { FixError, invariant } from "../core/errors.ts";
import type { OwnerService } from "../core/service.ts";
import type {
  Action,
  AppStatus,
  Mode,
  Plan,
  Recipe,
  Snapshot,
} from "../shared/types.ts";
import {
  agentRequest,
  type AgentRequest,
  type RelayJob,
} from "../shared/relay.ts";
import type { OwnerAuthentication } from "./auth.ts";

type Job = RelayJob & {
  state: "queued" | "delivered" | "completed";
  digest?: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
export class SessionBroker implements OwnerService {
  private session?: {
    id: string;
    source: Mode;
    expiresAt: number;
    lastPollAt: number;
  };
  private jobs = new Map<string, Job>();
  private waiter?: { finish: (job?: RelayJob) => void };
  private statusFlight?: Promise<AppStatus>;
  private stopping = false;
  constructor(
    readonly deviceId: string,
    private clock: () => number = Date.now,
    private requestTimeoutMs = 25_000,
  ) {}
  private active() {
    return (
      !!this.session && this.session.expiresAt > this.clock() && !this.stopping
    );
  }
  connect(
    deviceId: string,
    source: Mode,
    authorizationExpiresAt = this.clock() + 20 * 60_000,
  ) {
    invariant(
      !this.stopping,
      "COMPANION_STOPPING",
      "The gateway is stopping.",
      503,
    );
    invariant(
      deviceId === this.deviceId,
      "DEVICE_NOT_AUTHORIZED",
      "This deployment is bound to a different device.",
      403,
    );
    invariant(
      !this.active(),
      "SESSION_ACTIVE",
      "End the existing session before starting another.",
    );
    if (this.session) this.disconnect();
    this.session = {
      id: randomUUID(),
      source,
      expiresAt: Math.min(this.clock() + 20 * 60_000, authorizationExpiresAt),
      lastPollAt: this.clock(),
    };
    return { sessionId: this.session.id, expiresAt: this.session.expiresAt };
  }
  private requireSession(id?: string) {
    invariant(
      this.active() && (!id || id === this.session!.id),
      "DEVICE_SESSION_UNAVAILABLE",
      "The device session is absent or expired. Start it on the device.",
      503,
    );
    return this.session!;
  }
  async poll(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<RelayJob | undefined> {
    const session = this.requireSession(sessionId);
    session.lastPollAt = this.clock();
    invariant(
      !this.waiter,
      "POLL_IN_PROGRESS",
      "Only one device poll may be active.",
    );
    if (signal.aborted) return undefined;
    const take = () => {
      const job = [...this.jobs.values()].find((j) => j.state === "queued");
      if (job) {
        job.state = "delivered";
        return { id: job.id, request: job.request };
      }
    };
    const ready = take();
    if (ready) return ready;
    if (signal.aborted) return undefined;
    return new Promise((resolve) => {
      const finish = (job?: RelayJob) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (this.waiter?.finish === finish) this.waiter = undefined;
        resolve(job);
      };
      const abort = () => finish();
      const timer = setTimeout(
        () => finish(),
        Math.min(10_000, session.expiresAt - this.clock()),
      );
      this.waiter = { finish };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private async dispatch(
    request: AgentRequest,
    timeout = this.requestTimeoutMs,
  ): Promise<unknown> {
    this.requireSession();
    agentRequest.parse(request);
    invariant(
      this.jobs.size < 64,
      "DEVICE_BUSY",
      "The bounded device queue is full. Wait for current work.",
      429,
    );
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        const job = this.jobs.get(id);
        this.jobs.delete(id);
        reject(
          new FixError(
            job?.state === "delivered" &&
              request.tool === "fo_fix_execute_approved"
              ? "EXECUTION_UNCERTAIN"
              : "DEVICE_TIMEOUT",
            job?.state === "delivered" &&
              request.tool === "fo_fix_execute_approved"
              ? "The device did not return an execution result. Inspect its local journal; no automatic retry was made."
              : "The device did not respond. No request was redelivered.",
            504,
          ),
        );
      }, timeout);
      const job: Job = { id, request, state: "queued", resolve, reject, timer };
      this.jobs.set(id, job);
      if (this.waiter) {
        job.state = "delivered";
        this.waiter.finish({ id, request });
      }
    });
  }
  complete(sessionId: string, jobId: string, result: unknown) {
    this.requireSession(sessionId);
    const job = this.jobs.get(jobId);
    invariant(
      job,
      "JOB_UNAVAILABLE",
      "The request expired or belongs to another session.",
    );
    const digest = createHash("sha256")
      .update(JSON.stringify(result) ?? "undefined")
      .digest("hex");
    if (job.state === "completed") {
      invariant(
        job.digest === digest,
        "RESULT_MISMATCH",
        "A completed result cannot be replaced.",
      );
      return;
    }
    invariant(
      job.state === "delivered",
      "JOB_NOT_DELIVERED",
      "The request was not delivered to the device.",
    );
    job.state = "completed";
    job.digest = digest;
    clearTimeout(job.timer);
    // Keep a short bounded idempotency record for duplicate result delivery.
    job.timer = setTimeout(() => this.jobs.delete(jobId), 60_000);
    job.timer.unref?.();
    const data = result as {
      isError?: boolean;
      content?: { type: string; text?: string }[];
      structuredContent?: { result?: unknown };
    };
    if (data?.isError) {
      let code = "COMPANION_ERROR",
        message =
          "The companion rejected this operation. Check its local interface.";
      try {
        const error = JSON.parse(
          data.content?.find((c) => c.type === "text")?.text ?? "",
        );
        if (
          /^[A-Z_]{1,64}$/.test(error.code) &&
          typeof error.message === "string" &&
          error.message.length <= 512
        ) {
          code = error.code;
          message = error.message;
        }
      } catch {
        /* No unvalidated remote error object is logged. */
      }
      job.reject(new FixError(code, message));
    } else if (
      data?.structuredContent &&
      typeof data.structuredContent === "object" &&
      !Array.isArray(data.structuredContent) &&
      Object.hasOwn(data.structuredContent, "result") &&
      data.structuredContent.result !== undefined
    )
      job.resolve(data.structuredContent.result);
    else
      job.reject(
        new FixError(
          "INVALID_DEVICE_RESULT",
          "The companion returned an invalid result.",
          502,
        ),
      );
  }
  disconnect() {
    this.session = undefined;
    this.waiter?.finish();
    for (const job of this.jobs.values()) {
      clearTimeout(job.timer);
      if (job.state !== "completed")
        job.reject(
          new FixError(
            "DEVICE_SESSION_ENDED",
            "The device session ended. A delivered write may have completed; inspect its local journal.",
            503,
          ),
        );
    }
    this.jobs.clear();
  }
  private fallback(): AppStatus {
    return {
      name: "Fo Fix",
      mode: "unavailable",
      companion: "offline",
      approvalAuthority: "companion",
      lifecycle: this.stopping ? "stopping" : "ready",
      deviceSession: {
        connected: false,
        expiresAt: this.session
          ? new Date(this.session.expiresAt).toISOString()
          : undefined,
      },
      permission: {
        active: false,
        scope:
          "Inspection and specific approvals belong to the local companion.",
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
          "Fo registration is managed in Wajo. This gateway cannot verify the account registration; confirm it with a live Fo tool call.",
      },
      history: { redacted: true, actionCount: 0, planCount: 0, eventCount: 0 },
      actions: [],
      plans: [],
      events: [],
    };
  }
  async status(): Promise<AppStatus> {
    if (!this.active() || this.clock() - this.session!.lastPollAt > 30_000)
      return this.fallback();
    return (this.statusFlight ??= this.dispatch(
      { tool: "fo_fix_status", args: {} },
      3000,
    )
      .then((value) => {
        const status = value as AppStatus;
        invariant(
          status?.name === "Fo Fix" &&
            status.mode === this.session?.source &&
            Array.isArray(status.actions) &&
            Array.isArray(status.plans) &&
            !!status.permission &&
            !!status.history,
          "INVALID_DEVICE_RESULT",
          "The companion returned invalid status.",
          502,
        );
        return {
          ...status,
          approvalAuthority: "companion" as const,
          deviceSession: {
            connected: true,
            expiresAt: new Date(this.session!.expiresAt).toISOString(),
          },
        };
      })
      .catch(() => this.fallback())
      .finally(() => {
        this.statusFlight = undefined;
      }));
  }
  inspect() {
    return this.dispatch({
      tool: "fo_fix_inspect_output",
      args: {},
    }) as Promise<Snapshot>;
  }
  propose(recipe: Recipe, deviceId?: string) {
    return this.dispatch({
      tool: "fo_fix_propose_repair",
      args: { recipe, ...(deviceId === undefined ? {} : { deviceId }) },
    }) as Promise<Plan>;
  }
  execute(planId: string) {
    return this.dispatch({
      tool: "fo_fix_execute_approved",
      args: { planId },
    }) as Promise<Action>;
  }
  proposeUndo(actionId: string) {
    return this.dispatch({
      tool: "fo_fix_propose_undo",
      args: { actionId },
    }) as Promise<Plan>;
  }
  private localOnly(): never {
    throw new FixError(
      "LOCAL_COMPANION_REQUIRED",
      "Allow inspection and approve repairs in the local device interface. The cloud cannot grant or approve them.",
      403,
    );
  }
  grantPermission(): AppStatus {
    return this.localOnly();
  }
  revokePermission(): AppStatus {
    return this.localOnly();
  }
  async approve(): Promise<Plan> {
    return this.localOnly();
  }
  async deny(): Promise<Plan> {
    return this.localOnly();
  }
  async shutdown() {
    this.stopping = true;
    this.disconnect();
  }
}

export function mountSessionRoutes(
  app: Express,
  broker: SessionBroker,
  auth: OwnerAuthentication,
) {
  const id = z.uuid();
  app.post("/session/connect", auth.bearer("companion"), (req, res) => {
    const data = z
      .object({
        deviceId: z.string().min(1).max(128),
        source: z.enum(["fixture", "macos"]),
      })
      .strict()
      .parse(req.body);
    res.json(
      broker.connect(data.deviceId, data.source, res.locals.identity.expiresAt),
    );
  });
  app.post("/session/poll", auth.bearer("companion"), async (req, res) => {
    const data = z.object({ sessionId: id }).strict().parse(req.body);
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    const job = await broker.poll(data.sessionId, controller.signal);
    if (!res.destroyed) res.json({ job: job ?? null });
  });
  app.post("/session/result", auth.bearer("companion"), (req, res) => {
    const data = z
      .object({ sessionId: id, jobId: id, result: z.unknown() })
      .strict()
      .parse(req.body);
    broker.complete(data.sessionId, data.jobId, data.result);
    res.json({ accepted: true });
  });
  app.post("/api/device-session/end", auth.owner, (_req, res) => {
    broker.disconnect();
    res.json({ ended: true });
  });
}

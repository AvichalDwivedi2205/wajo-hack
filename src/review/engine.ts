import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  unlink,
  rmdir,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../core/store.ts";
import { FixError, invariant } from "../core/errors.ts";
import { safeRead, safePath, sha256, localName } from "./files.ts";
import { readSources } from "./manifest.ts";
import { analyze } from "./evidence.ts";
import { slidesFor } from "./render.ts";
import { checkOutput, nativeReceipt, type ReviewAdapter } from "./adapter.ts";
import { pptxRecipeSha256 } from "./pptx.ts";
import type {
  ReviewAgent,
  ReviewSnapshot,
  ReviewPlan,
  ReviewJob,
  ReviewStatus,
} from "./contracts.ts";

export class ReviewEngine implements ReviewAgent {
  private lease?: { until: number; scope: string; epoch: number };
  private epoch = 0;
  private snapshots = new Map<string, ReviewSnapshot>();
  private flight: Promise<unknown> = Promise.resolve();
  private workers = new Map<
    string,
    { done: Promise<void>; controller: AbortController }
  >();
  private stopping = false;
  private queued = 0;
  private readers = 0;
  private waitingReaders: Array<() => void> = [];
  constructor(
    readonly store: Store,
    readonly root: string,
    readonly adapter: ReviewAdapter,
    private clock = Date.now,
    readonly nativeHelper?: string,
    private timeoutMs = 120_000,
  ) {
    store.data.review ??= { plans: [], jobs: [] };
    for (const plan of this.data.plans)
      if (["pending", "approved"].includes(plan.state)) plan.state = "denied";
    for (const job of this.data.jobs)
      if (["queued", "running"].includes(job.state)) {
        job.state = "uncertain";
        job.message =
          "Companion restarted during the job. Verify existing artifacts; never automatically retry.";
      }
    store.save();
  }
  private get data() {
    return this.store.data.review!;
  }
  private get outputKind() {
    return this.adapter.outputKind ?? (this.adapter.synthetic ? "simulation" : "keynote");
  }
  private sourceMode(sources: Awaited<ReturnType<typeof readSources>>) {
    return sources.manifest.synthetic === this.adapter.synthetic &&
      (sources.manifest.outputKind === "pptx") === (this.outputKind === "pptx");
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    invariant(
      this.queued < 8,
      "REVIEW_BUSY",
      "The bounded review queue is full.",
      429,
    );
    this.queued++;
    const next = this.flight.then(operation, operation).finally(() => {
      this.queued--;
    });
    this.flight = next.catch(() => {});
    return next;
  }
  private allowed() {
    invariant(
      !this.stopping && this.lease && this.lease.until > this.clock(),
      "REVIEW_PERMISSION_REQUIRED",
      "Allow the three explicit review folders locally first. Audio permission does not grant file access.",
      403,
    );
    return this.lease!;
  }
  private async read<T>(operation: () => Promise<T>): Promise<T> {
    invariant(
      this.readers < 2 || this.waitingReaders.length < 24,
      "REVIEW_BUSY",
      "The bounded preview read queue is full.",
      429,
    );
    if (this.readers >= 2)
      await new Promise<void>((resolve) => this.waitingReaders.push(resolve));
    else this.readers++;
    try {
      return await operation();
    } finally {
      const next = this.waitingReaders.shift();
      if (next) next();
      else this.readers--;
    }
  }
  private async scope() {
    const ids = [];
    for (const name of ["", "Metrics", "Brief", "Creative", "Deliverables"]) {
      const path = await safePath(this.root, name),
        info = await lstat(path);
      invariant(
        info.isDirectory(),
        "REVIEW_SCOPE",
        "Each approved scope must be a real directory.",
      );
      ids.push([name, info.dev, info.ino]);
    }
    return sha256(JSON.stringify(ids));
  }
  private async fresh(snapshot: ReviewSnapshot) {
    const lease = this.allowed(),
      sources = await readSources(this.root);
    const scope = await this.scope();
    invariant(
      this.allowed().epoch === lease.epoch && scope === lease.scope,
      "REVIEW_REVOKED",
      "Review access or its scoped directories changed during inspection.",
    );
    invariant(
      this.sourceMode(sources) &&
        sha256(JSON.stringify({ sources: sources.digest, scope })) ===
          snapshot.digest,
      "REVIEW_STALE",
      "Source bytes, source selections, template or destination scope changed. Inspect and approve again.",
    );
    return sources;
  }
  status(): ReviewStatus {
    const active =
      !!this.lease && this.lease.until > this.clock() && !this.stopping;
    return {
      enabled: true,
      authority: "here",
      synthetic: this.adapter.synthetic,
      outputKind: this.outputKind,
      folders: ["Metrics", "Brief", "Creative"].map((f) => join(this.root, f)),
      destination: join(this.root, "Deliverables"),
      permission: {
        active,
        ...(this.lease
          ? { expiresAt: new Date(this.lease.until).toISOString() }
          : {}),
      },
      plans: this.data.plans.slice(-8).reverse(),
      jobs: this.data.jobs.slice(-8).reverse(),
      blockers: this.outputKind === "pptx" ? [
        "This route creates an editable PowerPoint deck and PDF on this Mac through OOXML, system Quick Look and Chrome print. No Keynote export or PowerPoint edit/resave is claimed.",
        "Actual visual sign-off and three live Fo round trips remain separate acceptance gates. Keynote cold-start acceptance is not passed by this alternative.",
      ] : this.adapter.synthetic
        ? [
            "Synthetic HTML/PDF simulation; no actual .key template or native Keynote export.",
            "Mac cold-start runs, actual visual inspection and live Fo round trips are not verified.",
          ]
        : [
            "Native recipe compilation and actual installed Keynote/template behavior require Mac acceptance.",
            "Five cold-start native runs, three live Fo round trips and actual visual inspection must be recorded separately.",
          ],
    };
  }
  async grant() {
    invariant(
      !this.stopping,
      "REVIEW_STOPPING",
      "The review companion is stopping.",
    );
    this.revoke();
    const operation = this.epoch;
    for (const folder of ["", "Metrics", "Brief", "Creative"])
      await safePath(this.root, folder);
    invariant(
      !this.stopping && this.epoch === operation,
      "REVIEW_REVOKED",
      "File access was revoked while the scope was being checked.",
    );
    try {
      await mkdir(join(this.root, "Deliverables"), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const scope = await this.scope();
    invariant(
      !this.stopping && this.epoch === operation,
      "REVIEW_REVOKED",
      "File access was revoked while the scope was being checked.",
    );
    this.lease = { until: this.clock() + 20 * 60_000, scope, epoch: operation };
    return this.status();
  }
  revoke() {
    this.epoch++;
    this.lease = undefined;
    this.snapshots.clear();
    for (const p of this.data.plans)
      if (["pending", "approved"].includes(p.state)) p.state = "denied";
    this.store.save();
    return this.status();
  }
  snapshot(): Promise<ReviewSnapshot> {
    return this.serial(() => this.capture());
  }
  private async capture(): Promise<ReviewSnapshot> {
    const lease = this.allowed();
    invariant(
      this.snapshots.size < 8,
      "REVIEW_LIMIT",
      "Re-allow the bounded review scope before another eight inspections.",
    );
    const sources = await readSources(this.root),
      scope = await this.scope();
    invariant(
      this.sourceMode(sources),
      "REVIEW_MODE",
      "The source manifest and adapter mode must match. There is no native-to-HTML fallback.",
    );
    const metric = await analyze(sources, this.nativeHelper);
    invariant(
      this.allowed().epoch === lease.epoch && scope === lease.scope,
      "REVIEW_REVOKED",
      "The review scope changed during inspection.",
    );
    const snapshot: ReviewSnapshot = {
      id: randomUUID(),
      digest: sha256(JSON.stringify({ sources: sources.digest, scope })),
      capturedAt: new Date(this.clock()).toISOString(),
      synthetic: this.adapter.synthetic,
      outputKind: this.outputKind,
      dataClassification: "synthetic-demo",
      cohort: sources.manifest.cohort,
      cutoff: sources.manifest.cutoff,
      ruleId: sources.manifest.ruleId,
      metric,
      sources: sources.manifest.files.map((f) => ({
        id: f.id,
        path: f.path,
        sha256: f.sha256,
        revision: f.revision,
        selected: sources.selected.get(f.role)?.id === f.id,
      })),
    };
    this.snapshots.set(snapshot.id, snapshot);
    return structuredClone(snapshot);
  }
  prepare(snapshotId: string) {
    return this.serial(() => this.prepareSnapshot(snapshotId));
  }
  private async prepareSnapshot(snapshotId: string) {
    const epoch = this.allowed().epoch;
    const snapshot = this.snapshots.get(snapshotId);
    invariant(
      snapshot,
      "REVIEW_SNAPSHOT",
      "Inspect an exact fresh snapshot first.",
    );
    await this.fresh(snapshot!);
    invariant(
      this.data.plans.length < 24,
      "REVIEW_LIMIT",
      "The bounded review journal is full. No history is silently deleted.",
    );
    const id = randomUUID();
    const recipeSha256 = this.outputKind === "pptx" ? await pptxRecipeSha256() : this.adapter.synthetic
      ? sha256("synthetic-html-pdf-v1")
      : sha256(
          await readFile(
            new URL("../../companion/macos/ReviewHelper.m", import.meta.url),
          ),
        );
    invariant(
      this.allowed().epoch === epoch,
      "REVIEW_REVOKED",
      "File access changed while the recipe was being pinned.",
    );
    const plan: ReviewPlan = {
      id,
      digest: "",
      snapshot: snapshot!,
      slides: slidesFor(snapshot!),
      destination: join(this.root, "Deliverables", `review-${id}`),
      expiresAt: new Date(this.clock() + 5 * 60_000).toISOString(),
      state: "pending",
      recipe: this.outputKind === "pptx" ? "pptx-fixed-slots-v1" : "keynote-fixed-slots-v1",
      recipeSha256,
      direction: "create",
    };
    plan.digest = this.planDigest(plan);
    this.data.plans.push(plan);
    this.store.save();
    return structuredClone(plan);
  }
  private planDigest(p: ReviewPlan) {
    return sha256(
      JSON.stringify({
        id: p.id,
        snapshot: p.snapshot,
        slides: p.slides,
        destination: p.destination,
        expiresAt: p.expiresAt,
        recipe: p.recipe,
        recipeSha256: p.recipeSha256,
        direction: p.direction,
        jobId: p.jobId,
      }),
    );
  }
  private plan(id: string) {
    const p = this.data.plans.find((p) => p.id === id);
    invariant(p, "REVIEW_PLAN", "Unknown review plan.", 404);
    return p!;
  }
  private job(id: string) {
    const j = this.data.jobs.find((j) => j.id === id);
    invariant(j, "REVIEW_JOB", "Unknown review job.", 404);
    return j!;
  }
  private pending(p: ReviewPlan, state: string) {
    this.allowed();
    invariant(
      p.state === state &&
        Date.parse(p.expiresAt) > this.clock() &&
        this.planDigest(p) === p.digest,
      "REVIEW_APPROVAL",
      "Review approval is missing, expired, consumed or changed.",
    );
  }
  async approve(id: string, digest: string) {
    return this.serial(async () => {
      const p = this.plan(id),
        epoch = this.allowed().epoch;
      this.pending(p, "pending");
      invariant(
        p.digest === digest,
        "REVIEW_DIGEST",
        "Approval does not match the exact slides, sources and output destination.",
      );
      await this.fresh(p.snapshot);
      this.pending(p, "pending");
      if (p.direction === "undo")
        await this.inventoryMatches(this.job(p.jobId!), p.destination);
      this.pending(p, "pending");
      invariant(
        this.allowed().epoch === epoch,
        "REVIEW_REVOKED",
        "Access changed while approval was being checked.",
      );
      p.state = "approved";
      this.store.save();
      return structuredClone(p);
    });
  }
  deny(id: string) {
    const p = this.plan(id);
    invariant(
      ["pending", "approved"].includes(p.state),
      "REVIEW_CLOSED",
      "The review plan is already closed.",
    );
    p.state = "denied";
    this.store.save();
    return structuredClone(p);
  }
  async commit(id: string): Promise<ReviewJob> {
    return this.serial(async () => {
      const p = this.plan(id);
      this.pending(p, "approved");
      invariant(
        this.workers.size === 0,
        "REVIEW_BUSY",
        "Only one bounded file-review job may run at a time.",
      );
      const sources = await this.fresh(p.snapshot);
      this.pending(p, "approved");
      if (p.direction === "undo") return this.remove(p);
      invariant(
        this.data.jobs.length < 20,
        "REVIEW_LIMIT",
        "The bounded review job journal is full.",
      );
      p.state = "consumed";
      const job: ReviewJob = {
        id: randomUUID(),
        planId: p.id,
        state: "queued",
        synthetic: this.adapter.synthetic,
        outputKind: this.outputKind,
        startedAt: new Date(this.clock()).toISOString(),
        message:
          "Approval consumed and job journaled. Output files have not been verified.",
        artifacts: [],
      };
      this.data.jobs.push(job);
      this.store.save();
      const controller = new AbortController(),
        epoch = this.allowed().epoch;
      const done = new Promise<void>((resolve) => setImmediate(resolve)).then(
        async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let execution: ReturnType<ReviewAdapter["execute"]> | undefined;
          try {
            invariant(
              this.allowed().epoch === epoch,
              "REVIEW_REVOKED",
              "Review access ended before the job started.",
            );
            await this.fresh(p.snapshot);
            invariant(
              !controller.signal.aborted,
              "REVIEW_INTERRUPTED",
              "The job stopped before the output write.",
            );
            job.state = "running";
            job.message =
              "Creating only the approved output copy. Rendering may take up to two minutes.";
            this.store.save();
            await safePath(this.root, "Deliverables");
            invariant(
              this.allowed().epoch === epoch && !controller.signal.aborted,
              "REVIEW_REVOKED",
              "Review access ended before the output directory write.",
            );
            await mkdir(p.destination, { mode: 0o700 });
            await safePath(this.root, localName(this.root, p.destination));
            const outputIdentity = await lstat(p.destination),
              lease = this.allowed();
            const boundary = async () => {
              invariant(
                this.allowed().epoch === epoch && !controller.signal.aborted,
                "REVIEW_REVOKED",
                "File access ended before an output write.",
              );
              const scope = await this.scope(),
                current = await lstat(
                  await safePath(
                    this.root,
                    localName(this.root, p.destination),
                  ),
                );
              invariant(
                scope === lease.scope &&
                  current.dev === outputIdentity.dev &&
                  current.ino === outputIdentity.ino &&
                  this.allowed().epoch === epoch &&
                  !controller.signal.aborted,
                "REVIEW_OUTPUT_CHANGED",
                "The approved output scope changed before a write.",
              );
            };
            invariant(
              this.allowed().epoch === epoch && !controller.signal.aborted,
              "REVIEW_REVOKED",
              "Review access ended before the native adapter started.",
            );
            execution = this.adapter.execute(
              p.destination,
              p,
              sources,
              controller.signal,
              boundary,
            );
            const nativeEvidence = await Promise.race([
              execution,
              new Promise<never>((_resolve, reject) => {
                const abort = () =>
                  reject(
                    new FixError(
                      "REVIEW_INTERRUPTED",
                      "The job stopped. Verify artifacts; never automatically retry.",
                    ),
                  );
                controller.signal.addEventListener("abort", abort, {
                  once: true,
                });
                if (controller.signal.aborted) {
                  abort();
                  return;
                }
                timer = setTimeout(() => controller.abort(), this.timeoutMs);
                timer.unref?.();
              }),
            ]);
            invariant(
              this.outputKind !== "keynote" || nativeEvidence,
              "REVIEW_RECIPE",
              "Native jobs require an actual fixed-helper receipt.",
            );
            invariant(
              !controller.signal.aborted,
              "REVIEW_INTERRUPTED",
              "The bounded job deadline ended.",
            );
            const { verification, checkedArtifacts, pptxEvidence } = await checkOutput(
              this.root,
              localName(this.root, p.destination),
              p,
              this.nativeHelper,
            );
            await this.fresh(p.snapshot);
            const receipt = this.outputKind !== "keynote"
              ? undefined
              : await nativeReceipt(
                  this.root,
                  localName(this.root, p.destination),
                  p,
                  nativeEvidence || undefined,
                );
            const artifacts = await this.inventory(p.destination);
            this.checkedArtifactsMatch(checkedArtifacts, artifacts);
            invariant(
              artifacts.some(
                (a) =>
                  a.name ===
                  (this.outputKind === "pptx" ? "review.pptx" : this.adapter.synthetic ? "review.html" : "review.key"),
              ),
              "REVIEW_ARTIFACT",
              "The expected editable output is missing.",
            );
            invariant(
              this.outputKind !== "keynote" ||
                artifacts.some(
                  (a) =>
                    a.name === "receipt.json" && a.sha256 === receipt?.sha256,
                ),
              "REVIEW_RECIPE",
              "Native verification requires its physical receipt in the artifact inventory.",
            );
            invariant(
              this.allowed().epoch === epoch && !controller.signal.aborted,
              "REVIEW_REVOKED",
              "File access ended during output verification.",
            );
            job.verification = verification;
            job.artifacts = artifacts;
            if (receipt) job.nativeEvidence = receipt.evidence;
            if (pptxEvidence) job.pptxEvidence = pptxEvidence;
            job.state = "succeeded";
            job.message = this.outputKind === "pptx" ? "Editable PowerPoint deck and PDF created here on this Mac. Complete deck bytes, PDF text and three independent PDF page renders checked; visual sign-off remains separate." : this.adapter.synthetic
              ? "Synthetic HTML/PDF simulation verified. This is not a Keynote or hardware result."
              : "Native output contents and page renders checked. Actual visual sign-off and readiness runs are still required.";
          } catch (error) {
            job.state = job.state === "queued" ? "failed" : "uncertain";
            job.message =
              error instanceof FixError
                ? error.message
                : "Review work could not be verified. Inspect local artifacts; no automatic retry was made.";
          } finally {
            clearTimeout(timer);
            job.completedAt = new Date(this.clock()).toISOString();
            this.store.save();
            // Keep the exclusive worker slot and journal open while a timed-out
            // adapter drains. Native execFile also has its own fixed 90s bound.
            await execution?.catch(() => {});
            this.workers.delete(job.id);
          }
        },
      );
      this.workers.set(job.id, { done, controller });
      return structuredClone(job);
    });
  }
  private async inventory(destination: string) {
    const directory = localName(this.root, destination);
    await safePath(this.root, directory);
    const names = (await readdir(destination)).sort();
    invariant(
      names.length <= 10 &&
        names.every((n) =>
          /^(review\.(pdf|html|json|key|pptx)|page-[123]\.png|template\.key|before\.png|proposed\.png|request\.json|receipt\.json)$/.test(
            n,
          ),
        ),
      "REVIEW_ARTIFACT",
      "Unexpected files in the generated artifact directory.",
    );
    const items = [];
    for (const name of names) {
      const b = await safeRead(
        this.root,
        `${directory}/${name}`,
        32 * 1024 * 1024,
      );
      items.push({ name, sha256: sha256(b), bytes: b.length });
    }
    return items;
  }
  private checkedArtifactsMatch(
    checked: { name: string; sha256: string }[],
    artifacts: ReviewJob["artifacts"],
  ) {
    invariant(
      checked.every((proof) =>
        artifacts.some(
          (artifact) =>
            artifact.name === proof.name && artifact.sha256 === proof.sha256,
        ),
      ),
      "REVIEW_ARTIFACT_CHANGED",
      "Generated artifacts changed after verification. Preserve the output; inspect it locally before preparing a fresh plan. No automatic retry was made.",
    );
  }
  private async inventoryMatches(job: ReviewJob, destination: string) {
    const now = await this.inventory(destination);
    invariant(
      job.artifacts.length > 0 &&
        JSON.stringify(now) === JSON.stringify(job.artifacts),
      "REVIEW_ARTIFACT_CHANGED",
      "Generated artifacts changed or contain unrelated files. Preserve them; undo is refused.",
    );
  }
  verify(id: string) {
    return this.serial(() => this.verifyJob(id));
  }
  private async verifyJob(id: string) {
    const epoch = this.allowed().epoch;
    const job = this.job(id),
      plan = this.plan(job.planId);
    if (this.workers.has(job.id)) return structuredClone(job);
    if (job.state === "succeeded" || job.state === "uncertain") {
      try {
        await this.fresh(plan.snapshot);
        if (job.artifacts.length)
          await this.inventoryMatches(job, plan.destination);
        const { verification, checkedArtifacts, pptxEvidence } = await checkOutput(
          this.root,
          localName(this.root, plan.destination),
          plan,
          this.nativeHelper,
        );
        const receipt = this.outputKind !== "keynote"
          ? undefined
          : await nativeReceipt(
              this.root,
              localName(this.root, plan.destination),
              plan,
              job.nativeEvidence,
            );
        invariant(
          this.outputKind !== "keynote" || receipt,
          "REVIEW_RECIPE",
          "The native recipe receipt must be checked before promotion.",
        );
        const artifacts = await this.inventory(plan.destination);
        this.checkedArtifactsMatch(checkedArtifacts, artifacts);
        invariant(
          artifacts.some(
            (a) =>
              a.name ===
              (this.outputKind === "pptx" ? "review.pptx" : this.adapter.synthetic ? "review.html" : "review.key"),
          ),
          "REVIEW_ARTIFACT",
          "The editable output is missing.",
        );
        invariant(
          this.outputKind !== "keynote" ||
            artifacts.some(
              (a) => a.name === "receipt.json" && a.sha256 === receipt?.sha256,
            ),
          "REVIEW_RECIPE",
          "Native verification requires a physical receipt in the inventory.",
        );
        await this.fresh(plan.snapshot);
        invariant(
          this.allowed().epoch === epoch,
          "REVIEW_REVOKED",
          "File access changed during output verification.",
        );
        job.artifacts = artifacts;
        if (receipt) job.nativeEvidence = receipt.evidence;
        if (pptxEvidence) job.pptxEvidence = pptxEvidence;
        job.state = "succeeded";
        job.message = this.outputKind === "pptx" ? "Editable PowerPoint deck and PDF created here on this Mac. Complete deck bytes, PDF text and three independent PDF page renders checked; visual sign-off remains separate." : this.adapter.synthetic
          ? "Synthetic HTML/PDF simulation verified. This is not a Keynote or hardware result."
          : "Native output contents and page renders checked. Actual visual sign-off and readiness runs are still required.";
        job.verification = {
          ...verification,
          visualApproved: job.verification?.visualApproved ?? false,
        };
        this.store.save();
      } catch (error) {
        job.state = "uncertain";
        delete job.verification;
        job.message =
          error instanceof FixError
            ? error.message
            : "Output verification failed. Preserve the artifacts and inspect them locally; no automatic retry was made.";
        this.store.save();
        throw error;
      }
    }
    invariant(
      this.allowed().epoch === epoch,
      "REVIEW_REVOKED",
      "File access changed during output verification.",
    );
    return structuredClone(job);
  }
  undo(id: string) {
    return this.serial(() => this.prepareUndo(id));
  }
  private async prepareUndo(id: string) {
    const epoch = this.allowed().epoch;
    const job = this.job(id),
      original = this.plan(job.planId);
    invariant(
      job.state === "succeeded",
      "REVIEW_UNDO",
      "Only verified unchanged generated artifacts can be proposed for removal.",
    );
    await this.fresh(original.snapshot);
    await this.inventoryMatches(job, original.destination);
    invariant(
      this.allowed().epoch === epoch,
      "REVIEW_REVOKED",
      "File access changed while undo was being prepared.",
    );
    invariant(
      this.data.plans.length < 24,
      "REVIEW_LIMIT",
      "The bounded review journal is full.",
    );
    const p: ReviewPlan = {
      ...structuredClone(original),
      id: randomUUID(),
      direction: "undo",
      jobId: id,
      state: "pending",
      expiresAt: new Date(this.clock() + 5 * 60_000).toISOString(),
    };
    p.digest = this.planDigest(p);
    this.data.plans.push(p);
    this.store.save();
    return structuredClone(p);
  }
  private async remove(p: ReviewPlan) {
    const job = this.job(p.jobId!);
    await this.inventoryMatches(job, p.destination);
    this.pending(p, "approved");
    p.state = "consumed";
    job.state = "uncertain";
    job.message = "Removing only the approved unchanged generated files.";
    this.store.save();
    try {
      for (const artifact of job.artifacts) {
        await this.inventoryMatches(job, p.destination);
        const path = await safePath(
          this.root,
          `${localName(this.root, p.destination)}/${artifact.name}`,
        );
        await unlink(path);
        job.artifacts = job.artifacts.filter((a) => a.name !== artifact.name);
        this.store.save();
      }
      await rmdir(p.destination);
      job.state = "undone";
      job.message =
        "Removed only the unchanged generated artifacts. All original sources were preserved.";
      this.store.save();
    } catch {
      job.state = "uncertain";
      job.message =
        "Artifact removal stopped. Preserve remaining files and inspect locally.";
      this.store.save();
    }
    return structuredClone(job);
  }
  image(role: "before" | "proposed", digest: string) {
    return this.read(() => this.readImage(role, digest));
  }
  private async readImage(role: "before" | "proposed", digest: string) {
    const lease = this.allowed();
    const sources = await readSources(this.root),
      scope = await this.scope();
    invariant(
      this.allowed().epoch === lease.epoch && scope === lease.scope,
      "REVIEW_REVOKED",
      "File access ended or its directories changed during the read.",
    );
    invariant(
      sha256(JSON.stringify({ sources: sources.digest, scope })) === digest,
      "REVIEW_STALE",
      "The screenshot no longer matches this exact reviewed snapshot.",
    );
    return sources.bytes.get(sources.selected.get(role)!.id)!;
  }
  artifact(id: string, name: string) {
    return this.read(() => this.readArtifact(id, name));
  }
  private async readArtifact(id: string, name: string) {
    const lease = this.allowed();
    const job = this.job(id),
      plan = this.plan(job.planId);
    invariant(
      job.state === "succeeded" &&
        job.artifacts.some((a) => a.name === name) &&
        /^(review\.(pdf|pptx)|page-[123]\.png)$/.test(name),
      "REVIEW_ARTIFACT",
      "Only verified PDF/page artifacts are viewable here.",
      404,
    );
    await this.inventoryMatches(job, plan.destination);
    const bytes = await safeRead(
        this.root,
        `${localName(this.root, plan.destination)}/${name}`,
        16 * 1024 * 1024,
      ),
      scope = await this.scope();
    invariant(
      this.allowed().epoch === lease.epoch && scope === lease.scope,
      "REVIEW_REVOKED",
      "File access ended during artifact read.",
    );
    invariant(
      sha256(bytes) === job.artifacts.find((a) => a.name === name)!.sha256,
      "REVIEW_ARTIFACT_CHANGED",
      "The viewed artifact changed during its read.",
    );
    return bytes;
  }
  async visualApprove(id: string) {
    const epoch = this.allowed().epoch,
      j = await this.verify(id);
    invariant(
      this.allowed().epoch === epoch,
      "REVIEW_REVOKED",
      "File access ended before visual approval.",
    );
    invariant(
      !j.synthetic && j.state === "succeeded" && j.verification,
      "REVIEW_VISUAL",
      "Synthetic renders cannot certify native hardware.",
    );
    this.job(id).verification!.visualApproved = true;
    this.store.save();
    return this.verify(id);
  }
  async shutdown() {
    this.stopping = true;
    this.revoke();
    for (const w of this.workers.values()) w.controller.abort();
    // Undo and inspections run on the serial flight, outside export workers.
    // Keep the journal open until these already-started operations settle too.
    await this.flight;
    await Promise.all([...this.workers.values()].map((w) => w.done));
  }
}

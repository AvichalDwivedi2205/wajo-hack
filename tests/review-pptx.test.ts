import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { unzipSync, strFromU8 } from "fflate";
import { ReviewEngine } from "../src/review/engine.ts";
import { PptxReviewAdapter, SyntheticReviewAdapter } from "../src/review/adapter.ts";
import { setupPptxReview } from "../src/review/setup-pptx.ts";
import { editablePptx } from "../src/review/pptx.ts";
import { readSources } from "../src/review/manifest.ts";
import { reviewJobSchema, reviewPlanSchema, reviewSnapshotSchema } from "../src/review/contracts.ts";
import { Store } from "../src/core/store.ts";

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "fo-pptx-test-"));
  const root = join(parent, "review");
  await setupPptxReview(root, fileURLToPath(new URL("../fixtures/client-review/", import.meta.url)), fileURLToPath(new URL("../fixtures/keynote-seed/Alder-review-seed.pptx", import.meta.url)));
  const store = new Store();
  const engine = new ReviewEngine(store, root, new PptxReviewAdapter());
  return { root, store, engine, close: async () => { await engine.shutdown(); store.close(); await rm(parent, { recursive: true, force: true }); } };
}
test("explicit PPTX setup preserves existing files, rejects mode mismatch, and produces editable source-bound OOXML", async () => {
  const c = await fixture();
  const other = new Store();
  const mismatch = new ReviewEngine(other, c.root, new SyntheticReviewAdapter());
  try {
    const before = await readSources(c.root);
    await assert.rejects(setupPptxReview(c.root, fileURLToPath(new URL("../fixtures/client-review/", import.meta.url)), fileURLToPath(new URL("../fixtures/keynote-seed/Alder-review-seed.pptx", import.meta.url))), /EEXIST/);
    await mismatch.grant();
    await assert.rejects(mismatch.snapshot(), /manifest and adapter mode/);
    await c.engine.grant();
    const snapshot = reviewSnapshotSchema.parse(await c.engine.snapshot());
    const plan = reviewPlanSchema.parse(await c.engine.prepare(snapshot.id));
    assert.equal(snapshot.synthetic, false);
    assert.equal(snapshot.outputKind, "pptx");
    assert.equal(plan.recipe, "pptx-fixed-slots-v1");
    assert.equal(reviewSnapshotSchema.safeParse({ ...snapshot, synthetic: true }).success, false);
    assert.equal(reviewPlanSchema.safeParse({ ...plan, recipe: "keynote-fixed-slots-v1" }).success, false);
    await assert.rejects(c.engine.commit(plan.id), /approval is missing/);
    assert.deepEqual(await readdir(join(c.root, "Deliverables")), []);
    await mkdir(plan.destination);
    await assert.rejects(new PptxReviewAdapter().execute(plan.destination, { ...plan, recipeSha256: "0".repeat(64) }, before, new AbortController().signal, async () => {}), /recipe changed after approval/);
    assert.deepEqual(await readdir(plan.destination), [], "Recipe drift must be refused before creating the first artifact.");
    const parts = unzipSync(editablePptx(plan, before));
    for (let i = 1; i <= 3; i++) {
      const xml = strFromU8(parts[`ppt/slides/slide${i}.xml`]);
      assert.equal((xml.match(/<p:sp>/g) ?? []).length, 4);
      assert.doesNotMatch(xml, /<a:t[^>]*>FO_REVIEW_/);
      assert.ok(xml.includes(plan.slides[i - 1].title));
    }
    for (const role of ["before", "proposed"] as const)
      assert.deepEqual(Buffer.from(parts[`ppt/media/${role}.png`]), before.bytes.get(before.selected.get(role)!.id));
    assert.equal((await readSources(c.root)).digest, before.digest);
  } finally { await mismatch.shutdown(); other.close(); await c.close(); }
});

test("real Mac PPTX job uses system rendering, independently verifies both deliverables, refuses tamper and separately approves undo", { skip: process.platform !== "darwin", timeout: 120_000 }, async () => {
  const c = await fixture();
  try {
    const originals = (await readSources(c.root)).digest;
    await c.engine.grant();
    const snapshot = await c.engine.snapshot();
    for (const tamper of [false, true]) {
      const plan = await c.engine.prepare(snapshot.id);
      await c.engine.approve(plan.id, plan.digest);
      const started = await c.engine.commit(plan.id);
      await assert.rejects(c.engine.commit(plan.id), /consumed/);
      let job = started;
      for (let i = 0; i < 900 && ["queued", "running"].includes(job.state); i++) {
        await delay(100);
        job = c.engine.status().jobs.find(j => j.id === started.id)!;
      }
      assert.equal(job.state, "succeeded", job.message);
      reviewJobSchema.parse(job);
      assert.equal(job.outputKind, "pptx");
      assert.equal(job.nativeEvidence, undefined);
      assert.equal(job.pptxEvidence?.renderer, "macos-quick-look+chrome");
      assert.equal(job.verification?.visualApproved, false);
      assert.equal(job.artifacts.length, 6);
      assert.ok((await c.engine.artifact(job.id, "review.pptx")).length > 0);
      assert.equal((await c.engine.verify(job.id)).state, "succeeded");
      if (tamper) {
        const path = join(plan.destination, "review.pptx");
        const bytes = await readFile(path);
        await writeFile(path, Buffer.concat([bytes, Buffer.from("unapproved")]));
        await assert.rejects(c.engine.verify(job.id), /changed/);
        assert.equal(c.engine.status().jobs.find(j => j.id === job.id)?.verification, undefined);
        await assert.rejects(c.engine.undo(job.id), /Only verified/);
        assert.ok((await readFile(path)).length > bytes.length);
      } else {
        const undo = await c.engine.undo(job.id);
        await assert.rejects(c.engine.commit(undo.id), /approval is missing/);
        await c.engine.approve(undo.id, undo.digest);
        assert.equal((await c.engine.commit(undo.id)).state, "undone");
        await assert.rejects(readFile(join(plan.destination, "review.pptx")), /ENOENT/);
      }
      assert.equal((await readSources(c.root)).digest, originals);
    }
  } finally { await c.close(); }
});

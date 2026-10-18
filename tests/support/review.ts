import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { ReviewEngine } from "../../src/review/engine.ts";
import {
  SyntheticReviewAdapter,
  type ReviewAdapter,
} from "../../src/review/adapter.ts";
import { Store } from "../../src/core/store.ts";
import { sha256 } from "../../src/review/files.ts";

export async function reviewFixture(
  adapter: ReviewAdapter = new SyntheticReviewAdapter(),
  timeout = 120_000,
) {
  const root = await mkdtemp(join(tmpdir(), "fo-review-test-"));
  await cp(
    fileURLToPath(new URL("../../fixtures/client-review/", import.meta.url)),
    root,
    { recursive: true, filter: (path) => !path.includes("/Deliverables") },
  );
  await mkdir(join(root, "Deliverables"), { mode: 0o700 });
  const store = new Store();
  let now = Date.now();
  const engine = new ReviewEngine(
    store,
    root,
    adapter,
    () => now,
    undefined,
    timeout,
  );
  return {
    root,
    store,
    engine,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      await engine.shutdown();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export type ReviewFixture = Awaited<ReturnType<typeof reviewFixture>>;
export async function rewrite(c: ReviewFixture, path: string, bytes: Buffer) {
  await writeFile(join(c.root, path), bytes);
  const manifest = JSON.parse(
    await readFile(join(c.root, "manifest.json"), "utf8"),
  );
  manifest.files.find((f: { path: string }) => f.path === path).sha256 =
    sha256(bytes);
  await writeFile(
    join(c.root, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
}
export async function bookChange(
  c: ReviewFixture,
  change: (files: Record<string, Uint8Array>) => void,
) {
  const parts = unzipSync(
    await readFile(join(c.root, "Metrics/metrics-r2.xlsx")),
  );
  change(parts);
  await rewrite(c, "Metrics/metrics-r2.xlsx", Buffer.from(zipSync(parts)));
}
export function editSheet(
  files: Record<string, Uint8Array>,
  sheet: number,
  change: (xml: string) => string,
) {
  const path = `xl/worksheets/sheet${sheet}.xml`;
  files[path] = strToU8(change(strFromU8(files[path])));
}
export async function prepared(c: ReviewFixture) {
  await c.engine.grant();
  const snapshot = await c.engine.snapshot();
  const plan = await c.engine.prepare(snapshot.id);
  return { snapshot, plan };
}
export async function finished(c: ReviewFixture, id: string, polls = 200) {
  for (let i = 0; i < polls; i++) {
    const job = c.engine.status().jobs.find((j) => j.id === id)!;
    if (!["queued", "running"].includes(job.state)) return job;
    await delay(25);
  }
  throw Error("Bounded synthetic job did not settle.");
}
export async function sourcePdf(lines: string[]) {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([842, 1000]);
  lines.forEach((s, i) =>
    page.drawText(s, { x: 30, y: 950 - i * 25, font, size: 11 }),
  );
  return Buffer.from(await pdf.save());
}
export function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

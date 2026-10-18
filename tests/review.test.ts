import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  symlink,
  unlink,
  utimes,
  lstat,
  readdir,
  mkdtemp,
  rm,
  rename,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { reviewDemoRoot, setupReviewDemo } from "../src/review/setup.ts";
import { join, dirname, basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { readSources } from "../src/review/manifest.ts";
import { spreadsheet } from "../src/review/evidence.ts";
import { ReviewEngine } from "../src/review/engine.ts";
import {
  SyntheticReviewAdapter,
  KeynoteReviewAdapter,
  checkOutput,
} from "../src/review/adapter.ts";
import { safeRead, sha256 } from "../src/review/files.ts";
import {
  reviewSnapshotSchema,
  reviewJobSchema,
} from "../src/review/contracts.ts";
import { validatePng, rasterHasInk } from "../src/review/png.ts";
import { inspectPdf } from "../src/review/pdf.ts";
import type { ReviewJob, ReviewPlan } from "../src/review/contracts.ts";
import { deflateSync, crc32 } from "node:zlib";
import {
  reviewFixture,
  rewrite,
  bookChange,
  editSheet,
  prepared,
  finished,
  sourcePdf,
  gate,
} from "./support/review.ts";

test("review scope is separate from audio; explicit revisions beat timestamps and yield exact ID-proven retained conversion", async () => {
  const c = await reviewFixture();
  try {
    await assert.rejects(c.engine.snapshot(), /three explicit review folders/);
    await utimes(
      join(c.root, "Metrics/metrics-r1.xlsx"),
      new Date("2035-01-01"),
      new Date("2035-01-01"),
    );
    const { snapshot, plan } = await prepared(c);
    assert.deepEqual(
      [
        snapshot.metric.paid,
        snapshot.metric.refunded,
        snapshot.metric.retained,
        snapshot.metric.visitors,
        snapshot.metric.basisPoints,
      ],
      [660, 120, 540, 12000, 450],
    );
    assert.equal(snapshot.metric.onePaymentPerVisitor, true);
    assert.equal(snapshot.metric.decision, "hold");
    assert.equal(
      snapshot.sources.find((s) => s.path.endsWith("metrics-r2.xlsx"))!
        .selected,
      true,
    );
    assert.equal(
      snapshot.sources.find((s) => s.path.endsWith("metrics-r1.xlsx"))!
        .selected,
      false,
    );
    assert.equal(reviewSnapshotSchema.safeParse(snapshot).success, true);
    assert.equal(plan.slides.length, 3);
    assert.match(plan.slides[1].body.join(" "), /Hypothesis/);
    assert.match(plan.slides[2].body.join(" "), /Maya Chen/);
    assert.equal(JSON.stringify(snapshot).includes("V00001"), false);
    assert.equal(JSON.stringify(plan).includes("base64"), false);
  } finally {
    await c.close();
  }
});
for (const [name, change] of [
  [
    "duplicate visitor IDs",
    (s: string) =>
      s.replace(
        'r="A3" t="inlineStr"><is><t>V00002',
        'r="A3" t="inlineStr"><is><t>V00001',
      ),
  ],
  [
    "missing visitor IDs",
    (s: string) =>
      s.replace(
        'r="A2" t="inlineStr"><is><t>V00001',
        'r="A2" t="inlineStr"><is><t>UNKNOWN',
      ),
  ],
] as const)
  test(`reject ${name}`, async () => {
    const c = await reviewFixture();
    try {
      await bookChange(c, (z) => editSheet(z, 2, change));
      await c.engine.grant();
      await assert.rejects(c.engine.snapshot());
    } finally {
      await c.close();
    }
  });
for (const [name, change] of [
  [
    "two paid transactions for one visitor",
    (s: string) =>
      s.replace(
        'r="B3" t="inlineStr"><is><t>V00002',
        'r="B3" t="inlineStr"><is><t>V00001',
      ),
  ],
  [
    "duplicate transaction IDs",
    (s: string) =>
      s.replace(
        'r="A3" t="inlineStr"><is><t>T00002',
        'r="A3" t="inlineStr"><is><t>T00001',
      ),
  ],
  [
    "unmatched paid visitor",
    (s: string) =>
      s.replace(
        'r="B2" t="inlineStr"><is><t>V00001',
        'r="B2" t="inlineStr"><is><t>V99999',
      ),
  ],
  [
    "impossible calendar date",
    (s: string) => s.replaceAll("2026-10-16T12:00:00Z", "2026-02-31T12:00:00Z"),
  ],
  [
    "paid after cutoff",
    (s: string) => s.replaceAll("2026-10-16T12:00:00Z", "2026-10-18T12:00:00Z"),
  ],
  [
    "wrong paid cohort",
    (s: string) => s.replaceAll("alder-oct-v1", "another-cohort"),
  ],
] as const)
  test(`reject ${name}`, async () => {
    const c = await reviewFixture();
    try {
      await bookChange(c, (z) => editSheet(z, 3, change));
      await c.engine.grant();
      await assert.rejects(c.engine.snapshot());
    } finally {
      await c.close();
    }
  });
for (const [name, change] of [
  ["duplicate refund", (s: string) => s + s.split("\n")[1] + "\n"],
  ["unmatched refund", (s: string) => s.replace("T00001", "T99999")],
  [
    "mismatched refund cohort",
    (s: string) => s.replace("alder-oct-v1", "other-cohort"),
  ],
  [
    "mismatched refund cutoff",
    (s: string) => s.replace("2026-10-17T23:59:59Z", "2026-10-18T23:59:59Z"),
  ],
  [
    "incorrect full refund amount",
    (s: string) => s.replace("10000,settled,full", "5000,settled,full"),
  ],
] as const)
  test(`reject ${name}`, async () => {
    const c = await reviewFixture();
    try {
      const path = "Metrics/refunds-r2.csv";
      await rewrite(
        c,
        path,
        Buffer.from(change(await readFile(join(c.root, path), "utf8"))),
      );
      await c.engine.grant();
      await assert.rejects(c.engine.snapshot());
    } finally {
      await c.close();
    }
  });
for (const formula of [
  "<f>1+1</f>",
  "<f/>",
  '<odd-prefix:f xmlns:odd-prefix="http://schemas.openxmlformats.org/spreadsheetml/2006/main">1+1</odd-prefix:f>',
])
  test("reject cached formula " + formula.slice(0, 22), async () => {
    const c = await reviewFixture();
    try {
      await bookChange(c, (z) =>
        editSheet(z, 3, (s) =>
          s.replace(
            '<c r="E2" t="inlineStr"><is><t>10000</t></is></c>',
            `<c r="E2">${formula}<v>10000</v></c>`,
          ),
        ),
      );
      await c.engine.grant();
      await assert.rejects(c.engine.snapshot());
    } finally {
      await c.close();
    }
  });
for (const part of ["xl/vbaProject.bin", "xl/externalLinks/externalLink1.xml"])
  test(`reject unsupported ${part}`, async () => {
    const c = await reviewFixture();
    try {
      await bookChange(c, (z) => {
        z[part] = strToU8("unsupported");
      });
      await c.engine.grant();
      await assert.rejects(c.engine.snapshot());
    } finally {
      await c.close();
    }
  });
test("reject forged ZIP expansion even when local and central declared lengths agree", () => {
  const bytes = Buffer.from(
    zipSync({
      "docProps/core.xml": strToU8("<x/>" + " ".repeat(9 * 1024 * 1024)),
    }),
  );
  const central = bytes.indexOf(Buffer.from([80, 75, 1, 2]));
  assert(central > 0);
  bytes.writeUInt32LE(4, 22);
  bytes.writeUInt32LE(4, central + 24);
  assert.throws(() => spreadsheet(bytes));
});
for (const kind of ["rules", "brief"] as const)
  test(`reject conflicting ${kind} PDF fields`, async () => {
    const c = await reviewFixture();
    try {
      const lines =
        kind === "rules"
          ? [
              "Alder measurement rules",
              "Rule: retained-v1",
              "Cohort: alder-oct-v1",
              "Cutoff: 2026-10-17T23:59:59Z",
              "Gate-basis-points: 500",
              "Numerator: paid unique visitors minus settled full refunds",
              "Denominator: unique cohort visitors",
              "Decision: hold below gate; never launch from this demo",
              "Denominator: all sessions",
            ]
          : [
              "Alder client brief",
              "Client: Alder",
              "Cohort: alder-oct-v1",
              "Owner: Maya Chen",
              "Readout: 2026-10-25",
              "Timeline: instrument, test, read out",
              "Hypothesis: simplify checkout to reduce friction",
              "Owner: Bob Stone",
            ];
      await rewrite(
        c,
        kind === "rules"
          ? "Brief/measurement-r2.pdf"
          : "Brief/client-brief-r3.pdf",
        await sourcePdf(lines),
      );
      await c.engine.grant();
      await assert.rejects(c.engine.snapshot());
    } finally {
      await c.close();
    }
  });
test("reject symlink source, traversal manifest, and oversized PNG before decoding", async () => {
  for (const kind of ["symlink", "traversal", "image"]) {
    const c = await reviewFixture();
    try {
      if (kind === "symlink") {
        const path = join(c.root, "Brief/notes-2026-10-18.txt");
        await unlink(path);
        await symlink(join(c.root, "Metrics/refunds-r2.csv"), path);
      }
      if (kind === "traversal") {
        const path = join(c.root, "manifest.json"),
          m = JSON.parse(await readFile(path, "utf8"));
        m.files[0].path = "../metrics-r2.xlsx";
        await writeFile(path, JSON.stringify(m));
      }
      if (kind === "image") {
        const p = "Creative/checkout-before.png",
          b = await readFile(join(c.root, p));
        b.writeUInt32BE(0x7fffffff, 16);
        await rewrite(c, p, b);
      }
      await c.engine.grant();
      await assert.rejects(c.engine.snapshot());
    } finally {
      await c.close();
    }
  }
});
test("bounded regular reads reject oversize before allocation", async () => {
  const c = await reviewFixture();
  try {
    await assert.rejects(safeRead(c.root, "Metrics/metrics-r2.xlsx", 100));
  } finally {
    await c.close();
  }
});
test("approval-only, async output verification, preserved originals and separately approved safe undo", async () => {
  let executions = 0;
  const actual = new SyntheticReviewAdapter();
  const c = await reviewFixture({
    synthetic: true,
    execute: async (...args) => {
      executions++;
      await delay(200);
      await actual.execute(...args);
    },
  });
  try {
    const { plan } = await prepared(c),
      original = await readSources(c.root);
    await assert.rejects(c.engine.commit(plan.id));
    await assert.rejects(c.engine.approve(plan.id, "0".repeat(64)));
    await c.engine.approve(plan.id, plan.digest);
    assert.equal(executions, 0);
    const start = Date.now(),
      job = await c.engine.commit(plan.id);
    assert.equal(job.state, "queued");
    assert(Date.now() - start < 3000);
    assert.equal(reviewJobSchema.safeParse(job).success, true);
    await assert.rejects(c.engine.commit(plan.id));
    const done = await finished(c, job.id);
    assert.equal(done.state, "succeeded", done.message);
    assert.equal(done.verification?.pages, 3);
    assert.equal(done.verification?.renderedPages, 3);
    assert.equal(done.verification?.visualApproved, false);
    assert.equal((await readSources(c.root)).digest, original.digest);
    assert.equal((await c.engine.verify(job.id)).state, "succeeded");
    assert.equal(executions, 1);
    const pdf = await c.engine.artifact(job.id, "review.pdf");
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 3);
    await assert.rejects(c.engine.visualApprove(job.id));
    const undo = await c.engine.undo(job.id);
    await assert.rejects(c.engine.commit(undo.id));
    await c.engine.approve(undo.id, undo.digest);
    assert.equal((await c.engine.commit(undo.id)).state, "undone");
    assert.deepEqual(await readdir(join(c.root, "Deliverables")), []);
    assert.equal((await readSources(c.root)).digest, original.digest);
  } finally {
    await c.close();
  }
});
for (const kind of ["source", "expired", "denied", "revoked"] as const)
  test(`commit refuses ${kind} approval`, async () => {
    const c = await reviewFixture();
    try {
      const { plan } = await prepared(c);
      await c.engine.approve(plan.id, plan.digest);
      if (kind === "source") {
        const p = join(c.root, "Brief/notes-2026-10-18.txt"),
          info = await lstat(p),
          bytes = await readFile(p);
        bytes[0] = bytes[0] === 83 ? 84 : 83;
        await writeFile(p, bytes);
        await utimes(p, info.atime, info.mtime);
      }
      if (kind === "expired") c.advance(5 * 60_000 + 1);
      if (kind === "denied") c.engine.deny(plan.id);
      if (kind === "revoked") c.engine.revoke();
      await assert.rejects(c.engine.commit(plan.id));
      assert.deepEqual(await readdir(join(c.root, "Deliverables")), []);
    } finally {
      await c.close();
    }
  });
test("revoke wins over delayed grant and denial wins over delayed create approval", async () => {
  const c = await reviewFixture();
  try {
    const original = (c.engine as any).scope.bind(c.engine),
      pause = gate(),
      started = gate();
    (c.engine as any).scope = async () => {
      started.resolve();
      await pause.promise;
      return original();
    };
    const grant = c.engine.grant();
    await started.promise;
    c.engine.revoke();
    pause.resolve();
    await assert.rejects(grant);
    assert.equal(c.engine.status().permission.active, false);
    (c.engine as any).scope = original;
    const { plan } = await prepared(c),
      fresh = (c.engine as any).fresh.bind(c.engine),
      hold = gate(),
      entered = gate();
    (c.engine as any).fresh = async (...a: unknown[]) => {
      const value = await fresh(...a);
      entered.resolve();
      await hold.promise;
      return value;
    };
    const approval = c.engine.approve(plan.id, plan.digest);
    await entered.promise;
    c.engine.deny(plan.id);
    hold.resolve();
    await assert.rejects(approval);
    assert.equal(c.engine.status().plans[0].state, "denied");
  } finally {
    await c.close();
  }
});
test("deny/revoke win over deferred undo inventory checks", async () => {
  const c = await reviewFixture();
  try {
    const { plan } = await prepared(c);
    await c.engine.approve(plan.id, plan.digest);
    const j = await c.engine.commit(plan.id);
    assert.equal((await finished(c, j.id)).state, "succeeded");
    const undo = await c.engine.undo(j.id),
      original = (c.engine as any).inventoryMatches.bind(c.engine),
      hold = gate(),
      entered = gate();
    (c.engine as any).inventoryMatches = async (...args: unknown[]) => {
      const result = await original(...args);
      entered.resolve();
      await hold.promise;
      return result;
    };
    const approving = c.engine.approve(undo.id, undo.digest);
    await entered.promise;
    c.engine.deny(undo.id);
    hold.resolve();
    await assert.rejects(approving);
    assert.equal(c.engine.status().plans[0].state, "denied");
    const waiting = gate(),
      started = gate();
    (c.engine as any).inventoryMatches = async (...args: unknown[]) => {
      const result = await original(...args);
      started.resolve();
      await waiting.promise;
      return result;
    };
    const preparing = c.engine.undo(j.id);
    await started.promise;
    c.engine.revoke();
    waiting.resolve();
    await assert.rejects(preparing);
    assert.equal(c.engine.status().permission.active, false);
    (c.engine as any).inventoryMatches = original;
  } finally {
    await c.close();
  }
});
test("PNG validator rejects high-bit chunk aliases, animations and concatenated compressed streams", () => {
  const chunk = (type: Buffer, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    type.copy(out, 4);
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  const prefix = Buffer.concat([signature, chunk(Buffer.from("IHDR"), header)]),
    end = chunk(Buffer.from("IEND"), Buffer.alloc(0)),
    valid = deflateSync(Buffer.from([0, 1, 2, 3]));
  assert.doesNotThrow(() =>
    validatePng(
      Buffer.concat([prefix, chunk(Buffer.from("IDAT"), valid), end]),
    ),
  );
  assert.throws(() =>
    validatePng(
      Buffer.concat([
        prefix,
        chunk(Buffer.from([0xc9, 68, 65, 84]), valid),
        chunk(Buffer.from("IDAT"), deflateSync(Buffer.alloc(32))),
        end,
      ]),
    ),
  );
  assert.throws(() =>
    validatePng(
      Buffer.concat([
        prefix,
        chunk(Buffer.from("acTL"), Buffer.alloc(8)),
        chunk(Buffer.from("IDAT"), valid),
        end,
      ]),
    ),
  );
  assert.throws(() =>
    validatePng(
      Buffer.concat([
        prefix,
        chunk(
          Buffer.from("IDAT"),
          Buffer.concat([valid, deflateSync(Buffer.alloc(32))]),
        ),
        end,
      ]),
    ),
  );
});
test("timed-out native-style work keeps exclusive worker and drains before shutdown; restart never replays", async () => {
  const hold = gate(),
    entered = gate();
  let calls = 0;
  const c = await reviewFixture(
    {
      synthetic: true,
      execute: async () => {
        calls++;
        entered.resolve();
        await hold.promise;
      },
    },
    20,
  );
  try {
    const { plan } = await prepared(c);
    await c.engine.approve(plan.id, plan.digest);
    const job = await c.engine.commit(plan.id);
    await entered.promise;
    assert.equal((await finished(c, job.id)).state, "uncertain");
    assert.equal((await c.engine.verify(job.id)).state, "uncertain");
    const next = await c.engine.prepare((await c.engine.snapshot()).id);
    await c.engine.approve(next.id, next.digest);
    await assert.rejects(c.engine.commit(next.id), /one bounded/);
    let stopped = false;
    const stop = c.engine.shutdown().then(() => {
      stopped = true;
    });
    await delay(10);
    assert.equal(stopped, false);
    hold.resolve();
    await stop;
    assert.equal(calls, 1);
    const restarted = new ReviewEngine(
      c.store,
      c.root,
      new SyntheticReviewAdapter(),
    );
    assert.equal(restarted.status().permission.active, false);
    assert.equal(restarted.status().jobs[0].state, "uncertain");
    await assert.rejects(restarted.commit(plan.id));
    await restarted.shutdown();
  } finally {
    hold.resolve();
    await c.close();
  }
});
test("undo refuses modified or unrelated artifacts and native mode never silently falls back", async () => {
  const c = await reviewFixture();
  try {
    const { plan } = await prepared(c);
    await c.engine.approve(plan.id, plan.digest);
    const j = await c.engine.commit(plan.id);
    assert.equal((await finished(c, j.id)).state, "succeeded");
    await writeFile(join(plan.destination, "unrelated.txt"), "preserve");
    await assert.rejects(c.engine.undo(j.id));
    assert.equal(
      await readFile(join(plan.destination, "unrelated.txt"), "utf8"),
      "preserve",
    );
    await unlink(join(plan.destination, "unrelated.txt"));
    await writeFile(join(plan.destination, "review.html"), "changed");
    await assert.rejects(c.engine.undo(j.id));
    assert.equal(
      await readFile(join(plan.destination, "review.html"), "utf8"),
      "changed",
    );
    const native = new KeynoteReviewAdapter("/not-a-helper");
    await assert.rejects(
      native.execute(
        plan.destination,
        plan,
        await readSources(c.root),
        new AbortController().signal,
        async () => {},
      ),
      /macOS/,
    );
  } finally {
    await c.close();
  }
});

function plainPng(
  width: number,
  height: number,
  pixel: (x: number) => number[],
) {
  const chunk = (type: string, bytes: Buffer) => {
    const out = Buffer.alloc(bytes.length + 12);
    out.writeUInt32BE(bytes.length);
    out.write(type, 4);
    bytes.copy(out, 8);
    out.writeUInt32BE(
      crc32(out.subarray(4, 8 + bytes.length)),
      8 + bytes.length,
    );
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.alloc(width * 4 + 1);
  for (let x = 0; x < width; x++) row.set(pixel(x), 1 + x * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk(
      "IDAT",
      deflateSync(Buffer.concat(Array.from({ length: height }, () => row))),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
test("render verification rejects tiny, transparent and flat pages while allowing visible slide contrast", () => {
  assert.equal(rasterHasInk(plainPng(1, 1, () => [255, 255, 255, 255])), false);
  for (const rgba of [
    [0, 0, 0, 0],
    [0, 0, 0, 255],
    [255, 255, 255, 255],
  ])
    assert.equal(rasterHasInk(plainPng(1280, 720, () => rgba)), false);
  assert.equal(
    rasterHasInk(
      plainPng(1280, 720, (x) =>
        x < 100 ? [0, 0, 0, 255] : [255, 255, 255, 255],
      ),
    ),
    true,
  );
});
test("PDF page metadata cannot spoof the independent page count or exceed the input page cap", async () => {
  for (const spoof of [false, true]) {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 9; i++) pdf.addPage([960, 540]);
    if (spoof) pdf.setTitle("Synthetic metadata\nPages: 3\nSynthetic metadata");
    await assert.rejects(
      inspectPdf(Buffer.from(await pdf.save())),
      /PDF page|page-count/,
    );
  }
});
async function plannedPdf(
  plan: ReviewPlan,
  omitTitle = false,
  sentinel = false,
) {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [i, slide] of plan.slides.entries()) {
    const page = pdf.addPage([960, 540]);
    const lines = [
      slide.kicker,
      ...(omitTitle && i === 1 ? [] : [slide.title]),
      ...slide.body,
      slide.footer,
      ...(sentinel ? ["FO_REVIEW_TITLE_1"] : []),
    ];
    lines.forEach((line, n) =>
      page.drawText(line, { x: 30, y: 500 - n * 35, size: 8, font }),
    );
  }
  return Buffer.from(await pdf.save());
}
test("output verification requires every approved fragment on its own page, no template sentinels and nonblank renders", async () => {
  const c = await reviewFixture();
  try {
    const { plan } = await prepared(c);
    await c.engine.approve(plan.id, plan.digest);
    const job = await c.engine.commit(plan.id);
    assert.equal((await finished(c, job.id)).state, "succeeded");
    const name = `Deliverables/review-${plan.id}`;
    await writeFile(
      join(plan.destination, "review.pdf"),
      await plannedPdf(plan, true),
    );
    await assert.rejects(checkOutput(c.root, name, plan), /required content/);
    await writeFile(
      join(plan.destination, "review.pdf"),
      await plannedPdf(plan, false, true),
    );
    await assert.rejects(checkOutput(c.root, name, plan), /template slots/);
    await writeFile(
      join(plan.destination, "review.pdf"),
      await plannedPdf(plan),
    );
    await writeFile(
      join(plan.destination, "page-2.png"),
      plainPng(1280, 720, () => [255, 255, 255, 255]),
    );
    await assert.rejects(checkOutput(c.root, name, plan), /nonblank/);
  } finally {
    await c.close();
  }
});
test("native receipt recovery always reads physical matching evidence even when cached (cloud adapter simulation only)", async () => {
  // Exercise the native receipt state machine with synthetic bytes and renderer.
  // This neither invokes Keynote nor provides any native acceptance evidence.
  const renderer = new SyntheticReviewAdapter();
  const c = await reviewFixture({
    synthetic: false,
    execute: async (directory, plan, sources, signal, boundary) => {
      await renderer.execute(directory, plan, sources, signal, boundary);
      await unlink(join(directory, "review.html"));
      await unlink(join(directory, "review.json"));
      await writeFile(
        join(directory, "review.key"),
        "synthetic test output; not a Keynote deck",
      );
      const evidence: NonNullable<ReviewJob["nativeEvidence"]> = {
        coldStart: true,
        keynoteVersion: "synthetic-test-only",
        dictionarySha256: "1".repeat(64),
        recipeSha256: plan.recipeSha256,
        copyLeftOpen: true,
      };
      await writeFile(
        join(directory, "receipt.json"),
        JSON.stringify(evidence),
      );
      return evidence;
    },
  });
  try {
    const manifest = JSON.parse(
      await readFile(join(c.root, "manifest.json"), "utf8"),
    );
    const entry = manifest.files.find(
      (f: { role: string }) => f.role === "template",
    );
    entry.path = "Creative/simulated-template.key";
    const candidate = Buffer.from(
      zipSync({
        "Index/Document.iwa": strToU8("synthetic structural candidate only"),
      }),
    );
    entry.sha256 = sha256(candidate);
    manifest.synthetic = false;
    await writeFile(join(c.root, entry.path), candidate);
    await writeFile(join(c.root, "manifest.json"), JSON.stringify(manifest));
    const { plan } = await prepared(c);
    await c.engine.approve(plan.id, plan.digest);
    const job = await c.engine.commit(plan.id);
    assert.equal((await finished(c, job.id)).state, "succeeded");
    const recorded = c.store.data.review!.jobs.find((j) => j.id === job.id)!;
    const evidence = structuredClone(recorded.nativeEvidence!);
    recorded.state = "uncertain";
    recorded.artifacts = []; // Simulate interrupted verification with cached metadata.
    await unlink(join(plan.destination, "receipt.json"));
    await assert.rejects(c.engine.verify(job.id));
    assert.equal(recorded.state, "uncertain");
    await writeFile(
      join(plan.destination, "receipt.json"),
      JSON.stringify({ ...evidence, recipeSha256: "0".repeat(64) }),
    );
    await assert.rejects(c.engine.verify(job.id), /physical native receipt/);
    await writeFile(
      join(plan.destination, "receipt.json"),
      JSON.stringify({ ...evidence, coldStart: false }),
    );
    await assert.rejects(c.engine.verify(job.id), /physical native receipt/);
    assert.deepEqual(recorded.nativeEvidence, evidence);
    await writeFile(
      join(plan.destination, "receipt.json"),
      JSON.stringify(evidence),
    );
    const checked = await c.engine.verify(job.id);
    assert.equal(checked.state, "succeeded");
    assert.equal(
      checked.artifacts.some((a) => a.name === "receipt.json"),
      true,
    );
  } finally {
    await c.close();
  }
});
test("parallel preview reads have a bounded queue and wrong snapshot digests never return source bytes", async () => {
  const c = await reviewFixture();
  try {
    const { snapshot } = await prepared(c);
    await assert.rejects(
      c.engine.image("before", "0".repeat(64)),
      /exact reviewed snapshot/,
    );
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        c.engine.image("before", snapshot.digest),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 26);
    assert.equal(results.filter((r) => r.status === "rejected").length, 4);
    c.engine.revoke();
    await assert.rejects(c.engine.image("before", snapshot.digest));
  } finally {
    await c.close();
  }
});

test("explicit cloud setup stages only synthetic source files under app data, reuses exact sources and never overwrites changed data", async () => {
  const c = await reviewFixture(),
    parent = await mkdtemp(join(tmpdir(), "fo-review-setup-"));
  try {
    const root = reviewDemoRoot(parent, join(parent, "data", "fixture.sqlite"));
    assert.equal(root, join(parent, "data", "client-review"));
    await setupReviewDemo(root, c.root);
    assert.equal(
      (await readSources(root)).digest,
      (await readSources(c.root)).digest,
    );
    assert.equal(
      (await readdir(root)).sort().join(","),
      "Brief,Creative,Metrics,manifest.json",
    );
    await setupReviewDemo(root, c.root);
    await writeFile(
      join(root, "Brief/notes-2026-10-18.txt"),
      "preserve changed local evidence",
    );
    await assert.rejects(setupReviewDemo(root, c.root));
    assert.equal(
      await readFile(join(root, "Brief/notes-2026-10-18.txt"), "utf8"),
      "preserve changed local evidence",
    );
  } finally {
    await c.close();
    await rm(parent, { recursive: true, force: true });
  }
});

test("an ancestor changed to a symlink at adapter entry cannot redirect generated bytes outside the approved output scope", async () => {
  const outside = await mkdtemp(join(tmpdir(), "fo-review-outside-")),
    actual = new SyntheticReviewAdapter();
  const c = await reviewFixture({
    synthetic: true,
    execute: async (...args) => {
      const [directory] = args,
        parent = dirname(directory);
      await rename(parent, parent + "-preserved");
      await mkdir(join(outside, basename(directory)));
      await symlink(outside, parent);
      await actual.execute(...args);
    },
  });
  try {
    const { plan } = await prepared(c);
    await c.engine.approve(plan.id, plan.digest);
    const job = await c.engine.commit(plan.id);
    assert.equal((await finished(c, job.id)).state, "uncertain");
    assert.deepEqual(
      await readdir(join(outside, basename(plan.destination))),
      [],
    );
  } finally {
    await c.close();
    await rm(outside, { recursive: true, force: true });
  }
});
test("shutdown waits for a consumed undo to finish journaling before the store may close", async () => {
  const c = await reviewFixture(),
    hold = gate(),
    entered = gate();
  try {
    const { plan } = await prepared(c);
    await c.engine.approve(plan.id, plan.digest);
    const job = await c.engine.commit(plan.id);
    assert.equal((await finished(c, job.id)).state, "succeeded");
    const undo = await c.engine.undo(job.id);
    await c.engine.approve(undo.id, undo.digest);
    const original = (c.engine as any).inventoryMatches.bind(c.engine);
    let checks = 0;
    (c.engine as any).inventoryMatches = async (...args: unknown[]) => {
      await original(...args);
      if (++checks === 2) {
        entered.resolve();
        await hold.promise;
      }
    };
    const removing = c.engine.commit(undo.id);
    await entered.promise;
    let stopped = false;
    const stopping = c.engine.shutdown().then(() => {
      stopped = true;
    });
    await delay(10);
    assert.equal(stopped, false);
    hold.resolve();
    assert.equal((await removing).state, "undone");
    await stopping;
    assert.equal(stopped, true);
  } finally {
    hold.resolve();
    await c.close();
  }
});
test("qualifying refund evidence identifies the actual rows when a valid pending refund is excluded", async () => {
  const c = await reviewFixture();
  try {
    const csv = (
      await readFile(join(c.root, "Metrics/refunds-r2.csv"), "utf8")
    ).split("\n");
    csv.splice(
      1,
      0,
      "R99999,T00660,alder-oct-v1,2026-10-17T23:59:59Z,r2,10000,pending,full",
    );
    await rewrite(c, "Metrics/refunds-r2.csv", Buffer.from(csv.join("\n")));
    const { snapshot } = await prepared(c);
    assert.equal(snapshot.metric.basisPoints, 450);
    assert.equal(snapshot.metric.refunded, 120);
    assert(
      snapshot.metric.trace.some((line) =>
        line.includes("rows 3:122 (120 matched settled full refunds)"),
      ),
    );
  } finally {
    await c.close();
  }
});

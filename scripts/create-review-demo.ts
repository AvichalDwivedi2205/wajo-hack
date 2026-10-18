// Explicit synthetic fixture creation; no user directories, credentials or network.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { chromium } from "@playwright/test";
import { sha256 } from "../src/review/files.ts";
import type { Manifest } from "../src/review/manifest.ts";

const root = resolve(process.argv[2] ?? "fixtures/client-review");
const cohort = "alder-oct-v1",
  cutoff = "2026-10-17T23:59:59Z";
const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
function workbook(revision: string, paidCount: number) {
  const data = [
    [
      ["key", "value"],
      ["cohort", cohort],
      ["cutoff", cutoff],
      ["revision", revision],
    ],
    [
      ["visitor_id", "cohort"],
      ...Array.from({ length: 12000 }, (_, i) => [
        `V${String(i + 1).padStart(5, "0")}`,
        cohort,
      ]),
    ],
    [
      [
        "transaction_id",
        "visitor_id",
        "cohort",
        "paid_at",
        "amount_cents",
        "status",
      ],
      ...Array.from({ length: paidCount }, (_, i) => [
        `T${String(i + 1).padStart(5, "0")}`,
        `V${String(i + 1).padStart(5, "0")}`,
        cohort,
        "2026-10-16T12:00:00Z",
        "10000",
        "paid",
      ]),
    ],
  ];
  const parts: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${[1, 2, 3].map((i) => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    ),
    "_rels/.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${["Meta", "Visitors", "Paid"].map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${[1, 2, 3].map((i) => `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`).join("")}</Relationships>`,
    ),
  };
  data.forEach((rows, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((r, j) => `<row r="${j + 1}">${r.map((v, k) => `<c r="${String.fromCharCode(65 + k)}${j + 1}" t="inlineStr"><is><t>${xml(v)}</t></is></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`,
    );
  });
  return Buffer.from(zipSync(parts));
}
async function pdf(lines: string[], handout?: string[]) {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica);
  for (const content of [lines, ...(handout ? [handout] : [])]) {
    const page = doc.addPage([842, 595]);
    page.drawRectangle({
      x: 0,
      y: 0,
      width: 842,
      height: 595,
      color: rgb(0.97, 0.95, 0.89),
    });
    content.forEach((line, i) =>
      page.drawText(line, {
        x: 40,
        y: 540 - i * 30,
        size: i === 0 ? 22 : 12,
        font,
        color: rgb(0.07, 0.23, 0.18),
      }),
    );
  }
  return Buffer.from(await doc.save());
}
const contents: Record<string, Buffer> = {
  "Metrics/metrics-r2.xlsx": workbook("r2", 660),
  "Metrics/metrics-r1.xlsx": workbook("r1", 600),
  "Brief/client-brief-r3.pdf": await pdf(
    [
      "Alder client brief",
      `Client: Alder`,
      `Cohort: ${cohort}`,
      "Owner: Maya Chen",
      "Readout: 2026-10-25",
      "Timeline: instrument, test, read out",
      "Hypothesis: simplify checkout to reduce friction",
    ],
    [
      "Alder prior slide handout",
      `Cohort: ${cohort}`,
      "Existing slide claims 5.5% gross conversion.",
      "Unreconciled historical claim; not the approved retained metric.",
    ],
  ),
  "Brief/measurement-r2.pdf": await pdf([
    "Alder measurement rules",
    "Rule: retained-v1",
    `Cohort: ${cohort}`,
    `Cutoff: ${cutoff}`,
    "Gate-basis-points: 500",
    "Numerator: paid unique visitors minus settled full refunds",
    "Denominator: unique cohort visitors",
    "Decision: hold below gate; never launch from this demo",
  ]),
  "Brief/notes-2026-10-18.txt": Buffer.from(
    `Synthetic dated review notes: 2026-10-18\nCohort: ${cohort}\nExisting slide claims 5.5% gross conversion.\nUse the approved retained metric and existing 5% gate.\n`,
  ),
  "Creative/template-synthetic.json": Buffer.from(
    JSON.stringify({
      kind: "synthetic-template-contract",
      oldClaim: "5.5%",
      slides: 3,
      brand: "Alder",
    }) + "\n",
  ),
};
for (const [revision, count] of [
  ["r2", 120],
  ["r1", 100],
] as const)
  contents[`Metrics/refunds-${revision}.csv`] = Buffer.from(
    "refund_id,transaction_id,cohort,cutoff,revision,amount_cents,status,kind\n" +
      Array.from(
        { length: count },
        (_, i) =>
          `R${String(i + 1).padStart(5, "0")},T${String(i + 1).padStart(5, "0")},${cohort},${cutoff},${revision},10000,settled,full\n`,
      ).join(""),
  );
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
});
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 720 },
    deviceScaleFactor: 1,
  });
  for (const proposed of [false, true]) {
    await page.setContent(
      `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;background:#f5f0e4;color:#153f32;font:20px system-ui;padding:42px}header{display:flex;justify-content:space-between;border-bottom:1px solid #b4bda9;padding-bottom:22px;font-size:16px;letter-spacing:3px}main{background:white;border-radius:20px;margin-top:35px;padding:38px;display:grid;grid-template-columns:1fr 1fr;gap:40px}h1{font:46px Georgia;margin:10px 0}h2{font:32px Georgia}label{display:block;color:#66716b;font-size:13px;margin:12px 0 6px}input{width:100%;padding:13px;border:1px solid #cbd2ca;border-radius:8px;background:#fbfcf8}button{display:block;background:#153f32;color:white;border:0;border-radius:8px;padding:18px;width:100%;margin-top:22px;font:18px system-ui}.tag{color:#8a611a;background:#fcf0d3;border-radius:20px;padding:8px 14px;font-size:12px}p{font-size:16px;color:#5f7168}.product{height:220px;background:#e4e9dd;border-radius:15px;display:grid;place-items:center;font:80px Georgia}footer{font-size:12px;margin-top:22px;color:#65786e}</style></head><body><header><b>ALDER / STUDIO</b><span>SYNTHETIC CHECKOUT</span></header><main><section><span class="tag">${proposed ? "PROPOSED · HYPOTHESIS" : "APPROVED BEFORE IMAGE"}</span><h1>${proposed ? "One step to a calmer day." : "Complete your order"}</h1><p>${proposed ? "Simplified steps. Clear delivery. A hypothesis to test." : "Please complete all fields to continue."}</p><label>Email</label><input value="synthetic@example.invalid" readonly>${proposed ? "" : "<label>Confirm email</label><input readonly><label>Referral code (optional)</label><input readonly>"}<label>Delivery address</label><input readonly><button>${proposed ? "Continue securely · $100" : "Proceed to next step"}</button></section><section><div class="product">a.</div><h2>The daily essentials</h2><p>One thoughtfully made studio kit.</p><b>$100</b><p>${proposed ? "Delivery included · Returns clearly explained" : "Shipping calculated at next step"}</p></section></main><footer>No live commerce or real customer data. ${proposed ? "Design improvement is a hypothesis, not a measured uplift." : "Approved comparison source for this synthetic demonstration."}</footer></body></html>`,
    );
    contents[`Creative/checkout-${proposed ? "proposed" : "before"}.png`] =
      await page.screenshot();
  }
} finally {
  await browser.close();
}
for (const folder of ["Metrics", "Brief", "Creative", "Deliverables"])
  await mkdir(join(root, folder), { recursive: true, mode: 0o700 });
for (const [path, bytes] of Object.entries(contents))
  await writeFile(join(root, path), bytes, { mode: 0o600, flag: "wx" });
const specs = [
  ["metrics-current", "metrics", "Metrics/metrics-r2.xlsx", "r2", "current"],
  ["metrics-old", "metrics", "Metrics/metrics-r1.xlsx", "r1", "superseded"],
  ["refunds-final", "refunds", "Metrics/refunds-r2.csv", "r2", "current"],
  ["refunds-old", "refunds", "Metrics/refunds-r1.csv", "r1", "superseded"],
  ["client-brief", "brief", "Brief/client-brief-r3.pdf", "r3", "current"],
  ["measurement", "rules", "Brief/measurement-r2.pdf", "r2", "current"],
  [
    "dated-notes",
    "notes",
    "Brief/notes-2026-10-18.txt",
    "d20261018",
    "current",
  ],
  [
    "before-approved",
    "before",
    "Creative/checkout-before.png",
    "approved-v1",
    "current",
  ],
  [
    "proposed-hypothesis",
    "proposed",
    "Creative/checkout-proposed.png",
    "hypothesis-v1",
    "current",
  ],
  [
    "template-contract",
    "template",
    "Creative/template-synthetic.json",
    "brand-v1",
    "current",
  ],
] as const;
const manifest: Manifest = {
  schema: 1,
  synthetic: true,
  dataClassification: "synthetic-demo",
  cohort,
  cutoff,
  ruleId: "retained-v1",
  folders: ["Metrics", "Brief", "Creative"],
  selection: {
    metrics: "r2",
    refunds: "r2",
    brief: "r3",
    rules: "r2",
    notes: "d20261018",
    before: "approved-v1",
    proposed: "hypothesis-v1",
    template: "brand-v1",
  },
  files: specs.map(([id, role, path, revision, status]) => ({
    id,
    role,
    path,
    revision,
    status,
    cohort,
    cutoff,
    sha256: sha256(contents[path]),
  })),
};
await writeFile(
  join(root, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log(
  `Created exactly ten synthetic source files in three folders at ${root}. The template JSON is a simulation contract, not a .key deck. No credentials or external requests.`,
);

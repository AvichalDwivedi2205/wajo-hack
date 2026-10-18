import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { zipSync, strFromU8, strToU8 } from "fflate";
import { XMLValidator } from "fast-xml-parser";
import { invariant } from "../core/errors.ts";
import { boundedZip } from "./zip.ts";
import { safeRead, sha256 } from "./files.ts";
import { pptxEvidenceSchema, type ReviewPlan } from "./contracts.ts";
import type { Sources } from "./manifest.ts";

const run = promisify(execFile);
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const pptxSeedSha256 = "265a5df40af4f9234f7b189e2cf8f9052ecb2ab66c6135022c9465c5510f5f77";
export function validatePptxSeed(bytes: Buffer) {
  invariant(sha256(bytes) === pptxSeedSha256, "REVIEW_TEMPLATE", "PPTX mode accepts only the reviewed fixed-slot OOXML seed. There is no renamed-file or Keynote fallback.");
}
export async function pptxRecipeSha256() {
  return sha256(await readFile(new URL("./pptx.ts", import.meta.url)));
}
const escapeXml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const decodeXml = (s: string) => s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");

// Edit real OOXML text runs. Never flatten slides into images or rename HTML.
// The complete seed is pinned; no macros, external relationships or arbitrary
// source HTML can enter the system previewer through this recipe.
export function editablePptx(plan: ReviewPlan, sources: Sources) {
  invariant(plan.recipe === "pptx-fixed-slots-v1" && sources.manifest.outputKind === "pptx" && !sources.manifest.synthetic, "REVIEW_MODE", "The exact plan and source manifest must select the PPTX recipe.");
  const seed = sources.bytes.get(sources.selected.get("template")!.id)!;
  validatePptxSeed(seed);
  const parts = boundedZip(seed, { entries: 64, total: 8 * 1024 * 1024, entry: 4 * 1024 * 1024, allowed: n => /^[A-Za-z0-9_.\[\]/-]+$/.test(n) });
  for (let i = 0; i < 3; i++) {
    const slide = plan.slides[i];
    let xml = strFromU8(parts[`ppt/slides/slide${i + 1}.xml`]);
    if (i === 0) {
      const old = [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].filter(m => m[0].includes("<a:t>5.5% gross conversion</a:t>"));
      invariant(old.length === 1, "REVIEW_TEMPLATE", "Expected the one superseded gross-conversion paragraph.");
      xml = xml.replace(old[0][0], "");
    }
    for (const key of ["kicker", "title", "body", "footer"] as const) {
      const marker = `FO_REVIEW_${key.toUpperCase()}_${i + 1}`;
      const matches = [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].filter(m => m[0].includes(`<a:t>${marker}</a:t>`));
      invariant(matches.length === 1, "REVIEW_TEMPLATE", "Expected exactly one fixed editable text slot.");
      const style = matches[0][0].match(/<a:rPr\b[\s\S]*?<\/a:rPr>/)?.[0];
      invariant(style, "REVIEW_TEMPLATE", "The pinned text slot needs its retained run style.");
      const values = key === "body" ? slide.body : [slide[key]];
      xml = xml.replace(matches[0][0], values.map(s => `<a:p><a:r>${style}<a:t xml:space="preserve">${escapeXml(s)}</a:t></a:r></a:p>`).join(""));
    }
    const text = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m => decodeXml(m[1]));
    invariant(XMLValidator.validate(xml) === true && !/FO_REVIEW_(?:KICKER|TITLE|BODY|FOOTER)_/.test(xml) && JSON.stringify(text) === JSON.stringify([slide.kicker, slide.title, ...slide.body, slide.footer]), "REVIEW_VERIFY", "Editable PPTX text must match every approved paragraph in order.");
    parts[`ppt/slides/slide${i + 1}.xml`] = strToU8(xml);
  }
  for (const role of ["before", "proposed"] as const)
    parts[`ppt/media/${role}.png`] = sources.bytes.get(sources.selected.get(role)!.id)!;
  return Buffer.from(zipSync(parts, { mtime: new Date("2026-01-01T00:00:00Z") }));
}

// System Quick Look renders the actual generated PPTX. Chrome prints that
// rendering in a fresh disposable profile. PDFKit independently checks its
// text and renders its pages elsewhere; this is not a Keynote export receipt.
export async function renderPptx(pptx: Buffer, recipeSha256: string, signal: AbortSignal) {
  invariant(process.platform === "darwin", "REVIEW_NATIVE_REQUIRED", "This explicit PPTX route requires macOS Quick Look and installed Google Chrome.");
  invariant(recipeSha256 === await pptxRecipeSha256(), "REVIEW_RECIPE", "The PPTX recipe changed after approval. Inspect and approve again.");
  const directory = await mkdtemp(join(await realpath(tmpdir()), "fo-review-pptx-"));
  try {
    const input = join(directory, "review.pptx");
    await writeFile(input, pptx, { flag: "wx", mode: 0o600 });
    await run("/usr/bin/qlmanage", ["-p", "-o", directory, input], { timeout: 30_000, maxBuffer: 64 * 1024, signal });
    const preview = "review.pptx.qlpreview";
    const names = await readdir(join(directory, preview));
    invariant(names.length <= 8 && names.every(n => /^(Preview\.html|PreviewProperties\.plist|Attachment[12]\.png)$/.test(n)), "REVIEW_RENDER", "Quick Look produced unexpected preview files.");
    let html = (await safeRead(directory, `${preview}/Preview.html`, 2 * 1024 * 1024)).toString("utf8");
    invariant((html.match(/class="slide"/g) ?? []).length === 3 && !/<(?:script|iframe|object|embed)\b|(?:https?:|file:|javascript:|@import)/i.test(html), "REVIEW_RENDER", "Expected three local, passive Quick Look slide renderings.");
    // Only two exact source images may be referenced by the generated preview.
    const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1]);
    invariant(refs.length === 2 && refs.every(n => /^Attachment[12]\.png$/.test(n)), "REVIEW_RENDER", "Unexpected preview resource reference.");
    html = html.replace("</head>", '<style>@page{size:960px 540px;margin:0}@media print{body{margin:0!important;background:white}div.slide{margin:0!important;box-shadow:none!important;break-after:page}div.slide:last-of-type{break-after:auto}}</style></head>');
    const print = join(directory, preview, "print.html");
    await writeFile(print, html, { flag: "wx", mode: 0o600 });
    const chromeVersion = (await run(chrome, ["--version"], { timeout: 5000, maxBuffer: 4096, signal })).stdout.trim();
    const pdfPath = join(directory, "review.pdf");
    await run(chrome, ["--headless", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-pdf-header-footer", "--host-resolver-rules=MAP * ~NOTFOUND", `--user-data-dir=${join(directory, "chrome-profile")}`, `--print-to-pdf=${pdfPath}`, pathToFileURL(print).href], { timeout: 30_000, maxBuffer: 256 * 1024, signal });
    const pdf = await safeRead(directory, "review.pdf", 16 * 1024 * 1024);
    const evidence = pptxEvidenceSchema.parse({ renderer: "macos-quick-look+chrome", chromeVersion, recipeSha256, pptxSha256: sha256(pptx), pdfSha256: sha256(pdf) });
    return { pdf, evidence };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

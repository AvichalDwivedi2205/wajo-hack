import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { invariant } from "../core/errors.ts";
import { renderCloudPdf, renderPdfPages, inspectPdf } from "./pdf.ts";
import { OutputDirectory, type OutputBoundary } from "./output.ts";
import { safeRead, sha256 } from "./files.ts";
import { syntheticOutput, syntheticHtml, expectedPageText } from "./render.ts";
import { rasterHasInk, sameRaster } from "./png.ts";
import type { ReviewPlan, ReviewOutputKind } from "./contracts.ts";
import { nativeEvidenceSchema, nativeIdentitySchema, pptxEvidenceSchema } from "./contracts.ts";
import type { ReviewJob } from "./contracts.ts";
import { readSources, type Sources } from "./manifest.ts";
import { editablePptx, pptxRecipeSha256, renderPptx } from "./pptx.ts";

const exec = promisify(execFile);
export async function nativeReceipt(
  root: string,
  directory: string,
  plan: ReviewPlan,
  cached?: ReviewJob["nativeEvidence"],
) {
  const bytes = await safeRead(root, `${directory}/receipt.json`, 4096);
  const receipt = nativeEvidenceSchema.parse(
    JSON.parse(bytes.toString("utf8")),
  );
  invariant(
    receipt.recipeSha256 === plan.recipeSha256 &&
      (!cached ||
        JSON.stringify(receipt) ===
          JSON.stringify(nativeEvidenceSchema.parse(cached))),
    "REVIEW_RECIPE",
    "The physical native receipt must match the approved recipe and any recorded evidence.",
  );
  return { evidence: receipt, sha256: sha256(bytes) };
}
export interface ReviewAdapter {
  synthetic: boolean;
  outputKind?: ReviewOutputKind;
  execute(
    directory: string,
    plan: ReviewPlan,
    sources: Sources,
    signal: AbortSignal,
    boundary: OutputBoundary,
  ): Promise<void | NonNullable<ReviewJob["nativeEvidence"]>>;
}
export class PptxReviewAdapter implements ReviewAdapter {
  synthetic = false;
  outputKind = "pptx" as const;
  async execute(directory: string, plan: ReviewPlan, sources: Sources, signal: AbortSignal, boundary: OutputBoundary) {
    invariant(plan.recipeSha256 === await pptxRecipeSha256(), "REVIEW_RECIPE", "The PPTX recipe changed after approval. Inspect and approve again before writing an output file.");
    const output = await OutputDirectory.open(directory, boundary);
    try {
      const pptx = editablePptx(plan, sources);
      await output.write("review.pptx", pptx);
      const { pdf, evidence } = await renderPptx(pptx, plan.recipeSha256, signal);
      await output.write("review.pdf", pdf);
      await renderCloudPdf(pdf, output.write.bind(output), signal);
      await output.write("receipt.json", JSON.stringify(evidence));
    } finally {
      await output.close();
    }
  }
}
export class SyntheticReviewAdapter implements ReviewAdapter {
  synthetic = true;
  async execute(
    directory: string,
    plan: ReviewPlan,
    sources: Sources,
    signal: AbortSignal,
    boundary: OutputBoundary,
  ) {
    const output = await OutputDirectory.open(directory, boundary);
    try {
      const write = output.write.bind(output);
      const pdf = await syntheticOutput(plan, sources, write);
      await renderCloudPdf(pdf, write, signal);
    } finally {
      await output.close();
    }
  }
}
export class KeynoteReviewAdapter implements ReviewAdapter {
  synthetic = false;
  constructor(readonly helper: string) {}
  async execute(
    directory: string,
    plan: ReviewPlan,
    sources: Sources,
    signal: AbortSignal,
    boundary: OutputBoundary,
  ) {
    invariant(
      process.platform === "darwin" && !sources.manifest.synthetic,
      "REVIEW_NATIVE_REQUIRED",
      "Native Keynote requires macOS, the reviewed helper and an actual approved .key template. There is no automatic fallback.",
    );
    const identity = nativeIdentitySchema.parse(
      JSON.parse(
        (
          await exec(this.helper, ["identity"], {
            timeout: 5000,
            maxBuffer: 4096,
            signal,
          })
        ).stdout,
      ),
    );
    invariant(
      identity.recipeSha256 === plan.recipeSha256,
      "REVIEW_RECIPE",
      "Rebuild the fixed native helper before staging any approved source copies.",
    );
    const output = await OutputDirectory.open(directory, boundary);
    try {
      for (const [role, name] of [
        ["template", "template.key"],
        ["before", "before.png"],
        ["proposed", "proposed.png"],
      ] as const)
        await output.write(
          name,
          sources.bytes.get(sources.selected.get(role)!.id)!,
        );
      const request = {
        recipe: plan.recipe,
        expectedRecipeSha256: plan.recipeSha256,
        outputIdentity: await output.identity(),
        sourceHashes: Object.fromEntries(
          (["template", "before", "proposed"] as const).map((role) => [
            role,
            sources.selected.get(role)!.sha256,
          ]),
        ),
        directory,
        slides: plan.slides,
      };
      await output.write("request.json", JSON.stringify(request));
      await output.check();
      await exec(this.helper, ["commit", join(directory, "request.json")], {
        timeout: 90_000,
        maxBuffer: 64 * 1024,
        signal,
      });
      await output.check();
      const receipt = nativeEvidenceSchema.parse(
        JSON.parse(
          (await safeRead(directory, "receipt.json", 4096)).toString("utf8"),
        ),
      );
      invariant(
        receipt.recipeSha256 === plan.recipeSha256 &&
          receipt.dictionarySha256 === identity.dictionarySha256 &&
          receipt.keynoteVersion === identity.keynoteVersion,
        "REVIEW_RECIPE",
        "Native helper differs from the exact approved recipe source. Rebuild and review again.",
      );
      return receipt;
    } finally {
      await output.close();
    }
  }
}
export async function checkOutput(
  root: string,
  directoryName: string,
  plan: ReviewPlan,
  nativeHelper?: string,
) {
  const pdf = await safeRead(
    root,
    `${directoryName}/review.pdf`,
    16 * 1024 * 1024,
  );
  const checkedArtifacts = [{ name: "review.pdf", sha256: sha256(pdf) }];
  const document = await inspectPdf(pdf, nativeHelper);
  invariant(
    document.pages === 3,
    "REVIEW_VERIFY",
    "Expected exactly three exported pages.",
  );
  const pages = document.text
    .split("\f")
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  invariant(
    pages.length === 3,
    "REVIEW_VERIFY",
    "Expected exactly three text-bearing PDF pages.",
  );
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  invariant(
    !/FO_REVIEW_/i.test(document.text),
    "REVIEW_VERIFY",
    "Unreplaced native template slots remain in the export.",
  );
  for (let i = 0; i < 3; i++)
    invariant(
      normalize(pages[i]) === normalize(expectedPageText(plan, i)),
      "REVIEW_VERIFY",
      `Exported page ${i + 1} does not match the complete approved text. Preserve the output; inspect the preview and prepare a fresh plan.`,
    );
  // Re-render the same immutable PDF bytes inspected above. Never treat
  // adapter-supplied PNGs as evidence of which PDF pages were actually rendered.
  for await (const { page, bytes } of renderPdfPages(pdf, nativeHelper)) {
    const png = await safeRead(
      root,
      `${directoryName}/page-${page}.png`,
      8 * 1024 * 1024,
    );
    checkedArtifacts.push({ name: `page-${page}.png`, sha256: sha256(png) });
    invariant(
      rasterHasInk(png),
      "REVIEW_RENDER",
      "Every PDF page needs a bounded nonblank independently rendered PNG.",
    );
    invariant(
      sameRaster(png, bytes),
      "REVIEW_RENDER",
      `Stored page-${page}.png does not match PDF page ${page}. Preserve the output and verify its rendering locally; no automatic retry was made.`,
    );
  }
  if (plan.snapshot.synthetic) {
    const sources = await readSources(root);
    invariant(
      JSON.stringify(
        sources.manifest.files.map((file) => ({
          id: file.id,
          path: file.path,
          sha256: file.sha256,
          revision: file.revision,
          selected: sources.selected.get(file.role)?.id === file.id,
        })),
      ) === JSON.stringify(plan.snapshot.sources),
      "REVIEW_STALE",
      "The approved sources changed. Prepare and approve a fresh plan.",
    );
    for (const [name, expected, limit] of [
      ["review.html", syntheticHtml(plan, sources), 16 * 1024 * 1024],
      ["review.json", JSON.stringify(plan.slides, null, 2) + "\n", 64 * 1024],
    ] as const) {
      const bytes = await safeRead(root, `${directoryName}/${name}`, limit);
      invariant(
        bytes.equals(Buffer.from(expected, "utf8")),
        "REVIEW_VERIFY",
        `The editable ${name} does not match the approved synthetic preview. Preserve the output and prepare a fresh plan.`,
      );
      checkedArtifacts.push({ name, sha256: sha256(bytes) });
    }
  }
  let pptxEvidence;
  if (plan.recipe === "pptx-fixed-slots-v1") {
    invariant(!plan.snapshot.synthetic && plan.snapshot.outputKind === "pptx" && plan.recipeSha256 === await pptxRecipeSha256(), "REVIEW_RECIPE", "The explicitly approved PPTX recipe must remain unchanged.");
    const sources = await readSources(root);
    const pptx = await safeRead(root, `${directoryName}/review.pptx`, 16 * 1024 * 1024);
    invariant(pptx.equals(editablePptx(plan, sources)), "REVIEW_VERIFY", "The complete editable PowerPoint archive differs from the approved text, source images or fixed template.");
    const bytes = await safeRead(root, `${directoryName}/receipt.json`, 4096);
    pptxEvidence = pptxEvidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
    invariant(pptxEvidence.recipeSha256 === plan.recipeSha256 && pptxEvidence.pptxSha256 === sha256(pptx) && pptxEvidence.pdfSha256 === sha256(pdf), "REVIEW_RECIPE", "The physical PPTX receipt must match the approved recipe and both actual output files.");
    checkedArtifacts.push({ name: "review.pptx", sha256: sha256(pptx) }, { name: "receipt.json", sha256: sha256(bytes) });
  }
  return {
    pptxEvidence,
    verification: {
      pages: 3,
      textChecked: true,
      originalsUnchanged: true,
      renderedPages: 3,
      visualApproved: false,
    },
    checkedArtifacts,
  };
}

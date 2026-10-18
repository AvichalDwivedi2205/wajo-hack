import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { invariant } from "../core/errors.ts";
import { renderCloudPdf, inspectPdf } from "./pdf.ts";
import { OutputDirectory, type OutputBoundary } from "./output.ts";
import { safeRead, sha256 } from "./files.ts";
import { syntheticOutput } from "./render.ts";
import { rasterHasInk } from "./png.ts";
import type { ReviewPlan } from "./contracts.ts";
import { nativeEvidenceSchema, nativeIdentitySchema } from "./contracts.ts";
import type { ReviewJob } from "./contracts.ts";
import type { Sources } from "./manifest.ts";

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
  execute(
    directory: string,
    plan: ReviewPlan,
    sources: Sources,
    signal: AbortSignal,
    boundary: OutputBoundary,
  ): Promise<void | NonNullable<ReviewJob["nativeEvidence"]>>;
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
  for (let i = 0; i < 3; i++)
    for (const marker of [
      plan.slides[i].kicker,
      plan.slides[i].title,
      ...plan.slides[i].body,
      plan.slides[i].footer,
    ])
      invariant(
        normalize(pages[i]).includes(normalize(marker)),
        "REVIEW_VERIFY",
        "A PDF page is missing its own required content or evidence footer.",
      );
  invariant(
    !/FO_REVIEW_/i.test(document.text),
    "REVIEW_VERIFY",
    "Unreplaced native template slots remain in the export.",
  );
  for (let page = 1; page <= 3; page++) {
    const png = await safeRead(
      root,
      `${directoryName}/page-${page}.png`,
      8 * 1024 * 1024,
    );
    invariant(
      rasterHasInk(png),
      "REVIEW_RENDER",
      "Every PDF page needs a bounded nonblank independently rendered PNG.",
    );
  }
  return {
    pages: 3,
    textChecked: true,
    originalsUnchanged: true,
    renderedPages: 3,
    visualApproved: false,
  };
}

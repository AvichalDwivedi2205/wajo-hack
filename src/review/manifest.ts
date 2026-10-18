import { z } from "zod";
import { invariant } from "../core/errors.ts";
import { safeRead, sha256 } from "./files.ts";
import { boundedZip } from "./zip.ts";
import { validatePng } from "./png.ts";
import { validatePptxSeed } from "./pptx.ts";

export const roles = [
  "metrics",
  "refunds",
  "brief",
  "rules",
  "notes",
  "before",
  "proposed",
  "template",
] as const;
const role = z.enum(roles);
const entry = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,60}$/),
    role,
    path: z
      .string()
      .regex(
        /^(Metrics|Brief|Creative)\/[A-Za-z0-9_-]+\.(xlsx|csv|pdf|txt|png|key|pptx|json)$/,
      ),
    revision: z.string().regex(/^[a-zA-Z0-9-]{1,40}$/),
    status: z.enum(["current", "superseded"]),
    cohort: z.string().max(64),
    cutoff: z.iso.datetime(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const manifestSchema = z
  .object({
    schema: z.literal(1),
    synthetic: z.boolean(),
    outputKind: z.literal("pptx").optional(),
    cohort: z.string().regex(/^[a-z0-9-]{1,64}$/),
    dataClassification: z.literal("synthetic-demo"),
    cutoff: z.iso.datetime(),
    ruleId: z.literal("retained-v1"),
    folders: z.tuple([
      z.literal("Metrics"),
      z.literal("Brief"),
      z.literal("Creative"),
    ]),
    selection: z
      .object(
        Object.fromEntries(roles.map((r) => [r, z.string().max(40)])) as Record<
          (typeof roles)[number],
          z.ZodString
        >,
      )
      .strict(),
    files: z.array(entry).length(10),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;
export async function readSources(root: string) {
  const manifestBytes = await safeRead(root, "manifest.json", 16 * 1024);
  const manifest = manifestSchema.parse(
    JSON.parse(manifestBytes.toString("utf8")),
  );
  invariant(!manifest.outputKind || !manifest.synthetic, "REVIEW_MODE", "Editable PPTX is a real file workflow with synthetic source data.");
  invariant(
    new Set(manifest.files.map((f) => f.id)).size === 10 &&
      new Set(manifest.files.map((f) => f.path)).size === 10,
    "REVIEW_AMBIGUOUS",
    "Source IDs and paths must be unique.",
  );
  const bytes = new Map<string, Buffer>();
  const selected = new Map<(typeof roles)[number], Manifest["files"][number]>();
  for (const file of manifest.files) {
    invariant(
      file.cohort === manifest.cohort && file.cutoff === manifest.cutoff,
      "REVIEW_COHORT",
      "Every declared source must match the explicit cohort and cutoff.",
    );
    const folder =
      file.role === "metrics" || file.role === "refunds"
        ? "Metrics"
        : ["brief", "rules", "notes"].includes(file.role)
          ? "Brief"
          : "Creative";
    const extension = {
      metrics: "xlsx",
      refunds: "csv",
      brief: "pdf",
      rules: "pdf",
      notes: "txt",
      before: "png",
      proposed: "png",
      template: manifest.outputKind === "pptx" ? "pptx" : manifest.synthetic ? "json" : "key",
    }[file.role];
    invariant(
      file.path.startsWith(folder + "/") && file.path.endsWith("." + extension),
      "REVIEW_MANIFEST",
      "The file role does not match its approved folder/format.",
    );
    const content = await safeRead(
      root,
      file.path,
      file.role === "template" ? 32 * 1024 * 1024 : 4 * 1024 * 1024,
    );
    invariant(
      sha256(content) === file.sha256,
      "REVIEW_HASH",
      "A source differs from the explicitly approved manifest. Review a new manifest; no timestamp selection is used.",
    );
    if (file.role === "before" || file.role === "proposed")
      validatePng(content);
    if (file.role === "template" && manifest.outputKind === "pptx")
      validatePptxSeed(content);
    if (file.role === "template" && !manifest.synthetic && !manifest.outputKind) {
      invariant(
        content.subarray(0, 2).toString() === "PK",
        "REVIEW_TEMPLATE",
        "Native mode requires a candidate zipped .key archive, never a renamed JSON or HTML file. Native opening and slot validation remain pending.",
      );
      const archive = boundedZip(content, {
        entries: 1024,
        total: 64 * 1024 * 1024,
        entry: 16 * 1024 * 1024,
        allowed: (n) => /^[A-Za-z0-9_. /-]+$/.test(n),
      });
      invariant(
        Object.keys(archive).some(
          (n) => n.startsWith("Index/") && n.endsWith(".iwa"),
        ),
        "REVIEW_TEMPLATE",
        "The native template is not a supported Keynote document archive.",
      );
    }
    bytes.set(file.id, content);
  }
  for (const role of roles) {
    const candidates = manifest.files.filter(
      (f) =>
        f.role === role &&
        f.status === "current" &&
        f.revision === manifest.selection[role],
    );
    invariant(
      candidates.length === 1 &&
        manifest.files.filter((f) => f.role === role && f.status === "current")
          .length === 1,
      "REVIEW_AMBIGUOUS",
      "Each role needs exactly one explicit current revision.",
    );
    selected.set(role, candidates[0]);
  }
  const digest = sha256(
    JSON.stringify({
      manifest: sha256(manifestBytes),
      files: manifest.files.map((f) => [f.id, f.path, f.sha256]),
    }),
  );
  return { manifest, selected, bytes, digest };
}
export type Sources = Awaited<ReturnType<typeof readSources>>;

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { safeRead, safePath, sha256 } from "./files.ts";
import { readSources, manifestSchema } from "./manifest.ts";
import { validatePptxSeed } from "./pptx.ts";
import { invariant } from "../core/errors.ts";

// Explicit setup only. A fresh root prevents rewriting any prior template,
// approval, output or uncertain native job. Never called by app startup.
export async function setupPptxReview(destination: string, bundled: string, seedPath: string) {
  const sources = await readSources(resolve(bundled));
  invariant(sources.manifest.synthetic, "REVIEW_MODE", "Setup accepts only the bundled synthetic source set.");
  const seed = await safeRead(dirname(seedPath), basename(seedPath), 4 * 1024 * 1024);
  validatePptxSeed(seed);
  const manifest = manifestSchema.parse({ ...sources.manifest, synthetic: false, outputKind: "pptx" });
  const template = manifest.files.find(f => f.role === "template")!;
  template.path = "Creative/client-review.pptx";
  template.id = "pptx-template";
  template.sha256 = sha256(seed);
  await safePath(dirname(destination));
  await mkdir(destination, { mode: 0o700 });
  await safePath(destination);
  for (const folder of [...manifest.folders, "Deliverables"])
    await mkdir(join(destination, folder), { mode: 0o700 });
  for (const file of manifest.files)
    await writeFile(join(destination, file.path), file.role === "template" ? seed : sources.bytes.get(file.id)!, { flag: "wx", mode: 0o600 });
  await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await readSources(destination);
  return destination;
}

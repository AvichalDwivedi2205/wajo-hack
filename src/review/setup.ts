import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { invariant } from "../core/errors.ts";
import { safePath, safeRead } from "./files.ts";
import { readSources } from "./manifest.ts";

export function reviewDemoRoot(project: string, dataPath?: string) {
  return join(
    dataPath && dataPath !== ":memory:"
      ? dirname(resolve(dataPath))
      : join(project, ".fo-fix"),
    "client-review",
  );
}
// Called only by the explicit setup command, never by discovery/grant/startup.
export async function setupReviewDemo(destination: string, bundled: string) {
  const sources = await readSources(bundled);
  invariant(
    sources.manifest.synthetic,
    "REVIEW_MODE",
    "Setup copies only the bundled synthetic demonstration.",
  );
  const data = dirname(destination);
  await safePath(dirname(data));
  try {
    await mkdir(data, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await safePath(data);
  let exists = false;
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    exists = true;
  }
  await safePath(destination);
  if (exists) {
    invariant(
      (await readSources(destination)).digest === sources.digest,
      "REVIEW_SETUP_EXISTS",
      "Existing review sources differ. Preserve them and choose a separate approved application data directory; setup never overwrites files.",
    );
    return destination;
  }
  for (const folder of sources.manifest.folders)
    await mkdir(join(destination, folder), { mode: 0o700 });
  for (const file of sources.manifest.files)
    await writeFile(join(destination, file.path), sources.bytes.get(file.id)!, {
      flag: "wx",
      mode: 0o600,
    });
  await writeFile(
    join(destination, "manifest.json"),
    await safeRead(bundled, "manifest.json", 16 * 1024),
    { flag: "wx", mode: 0o600 },
  );
  invariant(
    (await readSources(destination)).digest === sources.digest,
    "REVIEW_SETUP_CHANGED",
    "Source fixtures changed during setup. No automatic overwrite or retry.",
  );
  return destination;
}

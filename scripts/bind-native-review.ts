// Mac-only manual preparation after the user supplies an actual .key template.
// Never called by startup, MCP, the cloud relay or a browser.
import { readFile, writeFile } from "node:fs/promises";
import { dirname, basename, resolve, join } from "node:path";
import { safeRead, safePath, sha256 } from "../src/review/files.ts";
import { manifestSchema } from "../src/review/manifest.ts";
import { boundedZip } from "../src/review/zip.ts";
if (process.platform !== "darwin" || process.argv.length !== 4) {
  console.error(
    "Mac-only manual use: bind-native-review.ts /exact/demo/root /exact/approved/template.key. No Mac action was performed.",
  );
  process.exit(2);
}
const root = resolve(process.argv[2]),
  input = resolve(process.argv[3]);
if (!input.endsWith(".key"))
  throw Error("Select the actual saved Keynote file.");
const bytes = await safeRead(dirname(input), basename(input), 32 * 1024 * 1024);
const archive = boundedZip(bytes, {
  entries: 1024,
  total: 64 * 1024 * 1024,
  entry: 16 * 1024 * 1024,
  allowed: (n) => /^[A-Za-z0-9_. /-]+$/.test(n),
});
if (
  !Object.keys(archive).some(
    (n) => n.startsWith("Index/") && n.endsWith(".iwa"),
  )
)
  throw Error("Not a supported candidate Keynote archive; actual native opening remains a Mac gate.");
const manifest = manifestSchema.parse(
  JSON.parse((await safeRead(root, "manifest.json", 16384)).toString("utf8")),
);
await safePath(root, "Creative");
await writeFile(join(root, "Creative/client-review.key"), bytes, {
  flag: "wx",
  mode: 0o600,
});
const template = manifest.files.find((f) => f.role === "template")!;
template.path = "Creative/client-review.key";
template.id = "native-template";
template.sha256 = sha256(bytes);
manifest.synthetic = false;
await writeFile(
  join(root, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  "Bound the actual template copy by SHA-256. Data remain synthetic. No permission, job, credential or readiness gate was granted.",
);

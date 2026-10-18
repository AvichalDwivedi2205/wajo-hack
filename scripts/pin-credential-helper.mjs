// Hash the helper's static source only; never generate or read credentials.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const path = new URL("../tools/offline-credentials.html", import.meta.url);
const original = readFileSync(path, "utf8");
let updated = original;
for (const tag of ["script", "style"]) {
  const source = original.match(
    new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`),
  )?.[1];
  if (!source) throw new Error(`Missing ${tag} block`);
  const hash = createHash("sha256").update(source).digest("base64");
  updated = updated.replace(
    new RegExp(`${tag}-src 'sha256-[^']+'`),
    `${tag}-src 'sha256-${hash}'`,
  );
}
if (process.argv.includes("--write")) {
  writeFileSync(path, updated);
  console.log("Pinned helper CSP hashes. No credentials generated.");
} else if (updated !== original) {
  console.error(
    "Helper CSP hashes differ. Run node scripts/pin-credential-helper.mjs --write after formatting.",
  );
  process.exitCode = 1;
} else console.log("Helper CSP hashes match.");

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupPptxReview } from "../src/review/setup-pptx.ts";
if (process.argv.length !== 3) throw Error("Usage: npm run review:pptx:setup -- /exact/new/review-root (parent must exist)");
const root = resolve(process.argv[2]);
await setupPptxReview(root, fileURLToPath(new URL("../fixtures/client-review/", import.meta.url)), fileURLToPath(new URL("../fixtures/keynote-seed/Alder-review-seed.pptx", import.meta.url)));
console.log(`Staged ten synthetic sources for the real PPTX route: ${root}. No permissions or jobs granted.`);

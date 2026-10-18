// Explicit setup: copy public synthetic fixtures only beneath the app data dir.
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { reviewDemoRoot, setupReviewDemo } from "../src/review/setup.ts";
if (process.env.FO_FIX_MODE === "remote")
  throw Error(
    "The remote gateway never stages or parses review files. Set up only the local synthetic companion.",
  );
const project = fileURLToPath(new URL("../", import.meta.url));
await setupReviewDemo(
  reviewDemoRoot(project, process.env.FO_FIX_DATA),
  join(project, "fixtures/client-review"),
);
console.log(
  "Synthetic review fixtures are ready under the application data directory. No file lease, approval or credential was created.",
);

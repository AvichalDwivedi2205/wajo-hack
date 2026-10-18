// Read-only Mac readiness audit. Does not grant permission, approve, execute,
// quit Keynote, contact Fo, configure credentials or infer live Fo success.
import { readFile } from "node:fs/promises";
import { sha256 } from "../src/review/files.ts";
import { reviewJobSchema } from "../src/review/contracts.ts";
import { boundedJson } from "../src/shared/bounded-json.ts";
import { nativeIdentitySchema } from "../src/review/contracts.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
if (process.platform !== "darwin") {
  console.log(
    JSON.stringify({
      nativeReady: false,
      reason: "Mac unavailable; no native check was attempted.",
      liveFoReady: false,
    }),
  );
  process.exit(2);
}
const port = Number(process.argv[2] ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw Error("Use the explicit local companion port.");
const origin = `http://127.0.0.1:${port}`;
async function request(path: string, body?: unknown) {
  const response = await fetch(origin + path, {
    method: body ? "POST" : "GET",
    headers: { Origin: origin, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw Error(
      "Local review evidence unavailable. Check the local file lease; nothing was granted or retried.",
    );
  return boundedJson(response, 128 * 1024);
}
const status = (await request("/api/review")) as {
  authority?: string;
  jobs?: unknown[];
};
if (status.authority !== "here" || !Array.isArray(status.jobs))
  throw Error("Use the local native companion.");
const latest = status.jobs.slice(0, 5).map((j) => reviewJobSchema.parse(j));
const recipe = sha256(
  await readFile(new URL("../companion/macos/ReviewHelper.m", import.meta.url)),
);
const helper = fileURLToPath(
  new URL("../companion/macos/.build/fo-review", import.meta.url),
);
const identity = nativeIdentitySchema.parse(
  JSON.parse(
    (
      await promisify(execFile)(helper, ["identity"], {
        timeout: 5000,
        maxBuffer: 4096,
      })
    ).stdout,
  ),
);
if (identity.recipeSha256 !== recipe || identity.keynoteVersion === "unknown")
  throw Error(
    "Rebuild the fixed helper against the current installed Keynote before auditing.",
  );
const checked = [];
for (const job of latest) {
  if (job.synthetic || job.state !== "succeeded") {
    checked.push(job);
    continue;
  }
  checked.push(
    reviewJobSchema.parse(await request("/api/review/verify", { id: job.id })),
  );
}
const nativeReady =
  checked.length === 5 &&
  checked.every(
    (j) =>
      !j.synthetic &&
      j.state === "succeeded" &&
      j.nativeEvidence?.coldStart &&
      j.nativeEvidence.copyLeftOpen &&
      j.nativeEvidence.recipeSha256 === recipe &&
      j.nativeEvidence.dictionarySha256 === identity.dictionarySha256 &&
      j.nativeEvidence.keynoteVersion === identity.keynoteVersion &&
      j.verification?.pages === 3 &&
      j.verification.renderedPages === 3 &&
      j.verification.originalsUnchanged &&
      j.verification.visualApproved,
  );
console.log(
  JSON.stringify(
    {
      nativeReady,
      currentBuild: identity,
      requiredColdStarts: 5,
      observedJobs: checked.map((j) => ({
        id: j.id,
        state: j.state,
        synthetic: j.synthetic,
        coldStart: j.nativeEvidence?.coldStart ?? false,
        visualApproved: j.verification?.visualApproved ?? false,
      })),
      liveFoReady: false,
      liveFoReason:
        "Three consecutive actual Fo round trips require separate observed Fo evidence; SDK/cloud simulations never establish this gate.",
      readyForLiveDemo: false,
    },
    null,
    2,
  ),
);
if (!nativeReady) process.exitCode = 2;

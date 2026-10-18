import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FixError, invariant } from "../core/errors.ts";

const run = promisify(execFile);
const cloudHelper = fileURLToPath(
  new URL("../../scripts/review-pdf.py", import.meta.url),
);
// macOS uses only the fixed, locally compiled read-only PDF commands, including
// when testing explicitly synthetic output. This never selects a native writer.
const defaultNativeHelper =
  process.platform === "darwin"
    ? fileURLToPath(new URL("../../companion/macos/.build/fo-review", import.meta.url))
    : undefined;
export async function cloudPdf(
  mode: "text" | "info" | "render",
  path: string,
  prefix?: string,
  signal?: AbortSignal,
) {
  return run(
    "/usr/bin/python3",
    [cloudHelper, mode, path, ...(prefix ? [prefix] : [])],
    {
      timeout: mode === "render" ? 30_000 : 15_000,
      maxBuffer: mode === "render" ? 8 * 1024 * 1024 : 64 * 1024,
      encoding: mode === "render" ? null : "utf8",
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      signal,
    },
  );
}
export async function inspectPdf(
  buffer: Buffer,
  nativeHelper = defaultNativeHelper,
) {
  invariant(
    buffer.length <= 16 * 1024 * 1024 &&
      buffer.subarray(0, 5).toString() === "%PDF-",
    "REVIEW_PDF",
    "Expected a bounded PDF document.",
  );
  invariant(
    process.platform !== "darwin" || nativeHelper,
    "REVIEW_NATIVE_REQUIRED",
    "The fixed read-only PDF helper is required on macOS.",
  );
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "fo-review-pdf-"),
  );
  try {
    const path = join(directory, "source.pdf");
    await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
    const operation = async (mode: "text" | "info") => {
      if (process.platform !== "darwin") return cloudPdf(mode, path);
      try {
        return await run(nativeHelper!, [`pdf-${mode}`, path], {
          timeout: 15_000,
          maxBuffer: 64 * 1024,
        });
      } catch {
        throw new FixError(
          "REVIEW_PDF",
          "Native PDF page inspection was refused. Check the bounded file and fixed helper.",
        );
      }
    };
    const info = (await operation("info")).stdout.toString();
    const fields = [...info.matchAll(/^Pages:[ \t]+(\d+)[ \t]*$/gm)];
    invariant(
      process.platform === "darwin" || fields.length === 1,
      "REVIEW_PDF",
      "Ambiguous PDF page-count metadata is unsupported.",
    );
    const pages =
      process.platform === "darwin"
        ? JSON.parse(info).pages
        : Number(fields[0][1]);
    invariant(
      Number.isInteger(pages) && pages >= 1 && pages <= 8,
      "REVIEW_PDF",
      "Only one to eight PDF pages are supported.",
    );
    return { pages, text: (await operation("text")).stdout.toString() };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function pdfText(buffer: Buffer, nativeHelper?: string) {
  return (await inspectPdf(buffer, nativeHelper)).text;
}
export async function* renderPdfPages(
  buffer: Buffer,
  nativeHelper = defaultNativeHelper,
  signal?: AbortSignal,
) {
  invariant(
    buffer.length <= 16 * 1024 * 1024 &&
      buffer.subarray(0, 5).toString() === "%PDF-",
    "REVIEW_PDF",
    "Expected a bounded PDF document.",
  );
  invariant(
    process.platform !== "darwin" || nativeHelper,
    "REVIEW_NATIVE_REQUIRED",
    "The fixed read-only PDF renderer is required on macOS.",
  );
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "fo-review-render-"),
  );
  try {
    const path = join(directory, "source.pdf");
    await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
    for (const page of [1, 2, 3]) {
      const result =
        process.platform === "darwin"
          ? await run(nativeHelper!, ["pdf-render", path, String(page)], {
              timeout: 30_000,
              maxBuffer: 8 * 1024 * 1024,
              encoding: null,
              signal,
            })
          : await cloudPdf("render", path, String(page), signal);
      yield { page, bytes: Buffer.from(result.stdout) };
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function renderCloudPdf(
  buffer: Buffer,
  write: (name: string, bytes: Uint8Array) => Promise<void>,
  signal: AbortSignal,
) {
  for await (const { page, bytes } of renderPdfPages(buffer, undefined, signal))
    await write(`page-${page}.png`, bytes);
}

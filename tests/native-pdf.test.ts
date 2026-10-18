import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { inspectPdf, renderPdfPages } from "../src/review/pdf.ts";
import { validatePng, rasterHasInk } from "../src/review/png.ts";

test("fixed macOS PDFKit rendering passes the strict plain PNG contract without Automation", {
  skip: process.platform !== "darwin",
}, async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const page of [1, 2, 3]) {
    pdf.addPage([960, 540]).drawText(`Native PDFKit regression page ${page}`, {
      x: 48, y: 300, size: 36, font,
    });
  }
  const bytes = Buffer.from(await pdf.save());
  assert.equal((await inspectPdf(bytes)).pages, 3);
  let pages = 0;
  for await (const page of renderPdfPages(bytes)) {
    const image = validatePng(page.bytes);
    assert.deepEqual([image.width, image.height, image.channels], [1280, 720, 3]);
    assert.equal(rasterHasInk(page.bytes), true);
    pages++;
  }
  assert.equal(pages, 3);
});

test("native PDF reads accept canonical Mac temp paths while rejecting symlink aliases and traversal", {
  skip: process.platform !== "darwin",
}, async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "fo-native-path-test-"));
  const helper = fileURLToPath(new URL("../companion/macos/.build/fo-review", import.meta.url));
  const run = promisify(execFile);
  try {
    const pdf = await PDFDocument.create();
    pdf.addPage([960, 540]);
    const path = join(directory, "source.pdf");
    await writeFile(path, await pdf.save(), { flag: "wx", mode: 0o600 });
    assert.deepEqual(JSON.parse((await run(helper, ["pdf-info", path])).stdout), { pages: 1 });
    await symlink(path, join(directory, "alias.pdf"));
    await assert.rejects(run(helper, ["pdf-info", join(directory, "alias.pdf")]));
    await assert.rejects(run(helper, ["pdf-info", directory + "/../" + directory.split("/").at(-1) + "/source.pdf"]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

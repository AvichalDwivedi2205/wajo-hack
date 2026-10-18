import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readSources } from "../../src/review/manifest.ts";
import type { ReviewJob, ReviewPlan } from "../../src/review/contracts.ts";

test("real Mac app: local approval, SDK commit, editable PPTX/PDF verification and separately approved undo", async ({ page, request, baseURL }, info) => {
  const root = process.env.FO_FIX_REVIEW_ROOT!;
  const originals = (await readSources(root)).digest;
  const errors: string[] = [];
  let browserCommits = 0;
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (r.url().endsWith("/api/review/commit")) browserCommits++; });
  await page.goto("/");
  await page.getByRole("button", { name: "Client review", exact: true }).click();
  await expect(page.getByText("SYNTHETIC DATA / EDITABLE POWERPOINT", { exact: true })).toBeVisible();
  await expect(page.getByText("No personal device is connected. All device state and repairs are simulated.", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: "Allow these three review folders" }).click();
  const client = new Client({ name: "actual-mac-pptx-acceptance-sdk", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`)));
  try {
    async function call(name: string, args: Record<string, string>) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      const wrapped = result.structuredContent as { result: any };
      expect(wrapped).toHaveProperty("result");
      return wrapped.result;
    }
    const captured = await call("review.snapshot", {});
    const preview = await call("review.prepare", { snapshotId: captured.id });
    await expect(page.locator("article.review-slide")).toHaveCount(3);
    await expect(page.locator(".review-metric h2")).toContainText("4.5%");
    await expect(page.getByText("EDITABLE POWERPOINT + PDF", { exact: true })).toBeVisible();
    const unapproved = await client.callTool({ name: "review.commit", arguments: { id: preview.id } });
    expect(unapproved.isError).toBe(true);
    expect((await (await request.get("/api/review")).json()).jobs).toHaveLength(0);
    await page.getByRole("checkbox", { name: "I approve these exact sources, slides and output destination." }).check();
    await page.getByRole("button", { name: "Approve review for Fo" }).click();
    await expect(page.getByText("Approved. Waiting for Fo to call review.commit", { exact: false })).toBeVisible();
    expect((await (await request.get("/api/review")).json()).jobs).toHaveLength(0);
    const job = await call("review.commit", { id: preview.id }) as ReviewJob;
    await expect(page.getByRole("heading", { name: "PowerPoint review · succeeded" })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => page.locator(".review-renderings img").evaluateAll(images => images.length === 3 && images.every(i => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth === 1280))).toBe(true);
    const verified = await call("review.verify", { id: job.id }) as ReviewJob;
    expect(verified.state).toBe("succeeded");
    expect(verified.outputKind).toBe("pptx");
    expect(verified.nativeEvidence).toBeUndefined();
    expect(verified.pptxEvidence?.renderer).toBe("macos-quick-look+chrome");
    expect(verified.verification?.visualApproved).toBe(false);
    expect((await client.callTool({ name: "review.commit", arguments: { id: preview.id } })).isError).toBe(true);
    await expect(page.getByRole("link", { name: "Download verified editable PowerPoint deck" })).toBeVisible();
    for (const name of ["review.pptx", "review.pdf", "page-1.png", "page-2.png", "page-3.png"]) {
      const response = await request.get(`/api/review/jobs/${job.id}/artifacts/${name}`);
      expect(response.ok()).toBe(true);
      if (name.endsWith("pptx")) expect(response.headers()["content-disposition"]).toContain('attachment; filename="review.pptx"');
      await writeFile(info.outputPath(name), await response.body(), { flag: "wx", mode: 0o600 });
    }
    await writeFile(info.outputPath("acceptance.json"), JSON.stringify({ localSdkOnly: true, realFo: false, keynoteExport: false, plan: preview, job: verified, originalsUnchanged: (await readSources(root)).digest === originals }, null, 2), { flag: "wx", mode: 0o600 });
    await page.locator(".review-jobs").screenshot({ path: info.outputPath("app-verified.png") });
    const undo = await call("review.undo", { id: job.id }) as ReviewPlan;
    await expect(page.getByRole("heading", { name: "Review removal of generated copies" })).toBeVisible();
    expect((await client.callTool({ name: "review.commit", arguments: { id: undo.id } })).isError).toBe(true);
    await page.getByRole("checkbox", { name: "I approve these exact sources, slides and output destination." }).check();
    await page.getByRole("button", { name: "Approve review for Fo" }).click();
    await expect(page.getByText("Approved. Waiting for Fo to call review.commit", { exact: false })).toBeVisible();
    expect((await call("review.commit", { id: undo.id })).state).toBe("undone");
    await expect(page.getByRole("heading", { name: "PowerPoint review · undone" })).toBeVisible();
    expect((await readSources(root)).digest).toBe(originals);
    expect(browserCommits).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await client.close();
    await request.delete("/api/review/permission", { headers: { Origin: baseURL! }, data: {} });
  }
});

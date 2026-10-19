import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test.beforeEach(async ({ request, baseURL }) => {
  expect((await request.delete("/api/folders/lease", { headers: { Origin: baseURL! }, data: {} })).ok()).toBe(true);
});

test("folder consent is a local three-hour lease that MCP cannot grant; revoke stops Fo immediately", async ({ page, baseURL, request }) => {
  const client = new Client({ name: "synthetic-browser-folder-client", version: "1" });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`)));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("files.write");
    expect(names.some((n) => /grant|lease|allow/.test(n))).toBe(false);
    expect((await call("files.list", { path: "" })).isError).toBe(true);
    // A request without the local page's exact Origin cannot grant.
    expect((await request.post("/api/folders/lease", { data: {} })).status()).toBe(403);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("navigation").getByRole("button", { name: "Folders for Fo", exact: true }).click();
    const panel = page.getByRole("region", { name: "Folders for Fo" });
    await expect(panel.getByRole("heading", { name: "Allowed folders" })).toBeVisible();
    await expect(panel.getByText("e2e-folders", { exact: true })).toBeVisible();
    await expect(panel.getByRole("status")).toHaveText("Fo cannot use these folders now.");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await panel.getByRole("button", { name: "Allow Fo for 3 hours" }).click();
    await expect(panel.getByRole("status")).toContainText("Fo can use these folders until");
    const path = `Notes/e2e-${randomUUID()}.md`;
    const written = await call("files.write", { path, content: "# From the browser test\n", mode: "create" });
    expect(written.isError).not.toBe(true);
    const writeId = (written.structuredContent as { result: { writeId: string } }).result.writeId;
    await expect(panel.getByText(path.split("/")[1], { exact: false })).toBeVisible();
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations.map((v) => v.id)).toEqual([]);
    expect((await call("files.undo_write", { writeId })).isError).not.toBe(true);
    await panel.getByRole("button", { name: "Revoke" }).click();
    await expect(panel.getByRole("status")).toHaveText("Fo cannot use these folders now.");
    const after = await call("files.list", { path: "" });
    expect(after.isError).toBe(true);
    expect(JSON.stringify(after.content)).toContain("FOLDER_LEASE_REQUIRED");
  } finally {
    await client.close();
  }
});

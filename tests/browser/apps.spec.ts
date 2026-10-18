import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("app consent and approve-for-Fo never launch before the SDK execution; replay and revocation are blocked", async ({
  page,
  baseURL,
}) => {
  const client = new Client({
    name: "synthetic-browser-app-client",
    version: "1",
  });
  const call = (name: string, args = {}) =>
    client.callTool({ name, arguments: args });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`)),
    );
    await page.goto("/");
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Open apps", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Allow supported-app inspection" })
      .click();
    await page
      .getByRole("button", { name: "Inspect supported apps", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Review opening Spotify" }),
    ).toBeVisible();
    const p = (
      (await call("apps.propose_open", { appId: "spotify" }))
        .structuredContent as { result: { id: string } }
    ).result;
    expect((await call("apps.open_approved", { id: p.id })).isError).toBe(true);
    const review = page.getByRole("region", {
      name: "Review Open Spotify",
      exact: true,
    });
    await expect(
      review.getByRole("button", { name: "Approve for Fo" }),
    ).toBeDisabled();
    await review
      .getByRole("checkbox", { name: "I approve opening this app." })
      .check();
    await review.getByRole("button", { name: "Approve for Fo" }).click();
    await expect(review.getByRole("status")).toHaveText(
      "Approved. Waiting for Fo to open this exact app.",
    );
    const before = (
      (await call("apps.inspect")).structuredContent as {
        result: { actions: unknown[] };
      }
    ).result;
    expect(before.actions).toHaveLength(0);
    await page.reload();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Open apps", exact: true })
      .click();
    await expect(page.getByRole("status")).toHaveText(
      "Approved. Waiting for Fo to open this exact app.",
    );
    const action = (
      (await call("apps.open_approved", { id: p.id })).structuredContent as {
        result: { state: string; source: string };
      }
    ).result;
    expect(action).toMatchObject({ state: "succeeded", source: "fixture" });
    await expect(
      page.getByText(
        "Synthetic app-opening state verified. No native app was opened.",
      ),
    ).toBeVisible();
    expect((await call("apps.open_approved", { id: p.id })).isError).toBe(true);
    const revoked = (
      (await call("apps.propose_open", { appId: "calculator" }))
        .structuredContent as { result: { id: string } }
    ).result;
    await page.getByRole("button", { name: "Revoke app access" }).click();
    expect((await call("apps.open_approved", { id: revoked.id })).isError).toBe(
      true,
    );
  } finally {
    await client.close();
  }
});

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "node:crypto";

test.beforeEach(async ({ request, baseURL }) => {
  expect(
    (
      await request.delete("/api/review/permission", {
        headers: { Origin: baseURL! },
        data: {},
      })
    ).ok(),
  ).toBe(true);
});
test("mobile layout requires local folder consent and a separate exact-session phone opt-in", async ({ page, request, baseURL }) => {
  const link = { sessionId: randomUUID(), origin: "https://phone-review.fixture.invalid", deviceId: "synthetic-browser-device", expiresAt: Date.now() + 60_000 };
  expect((await request.post("/api/review/phone/link", { headers: { Origin: baseURL! }, data: link })).ok()).toBe(true);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.getByRole("button", { name: "Client review", exact: true }).click();
    const consent = page.getByRole("checkbox", { name: "I allow owner phone review for this exact gateway, device and session." }),
      enable = page.getByRole("button", { name: "Enable this phone review session" });
    await expect(consent).toBeDisabled();
    await expect(enable).toBeDisabled();
    await page.getByRole("button", { name: "Allow these three review folders" }).click();
    await expect(consent).toBeEnabled();
    await expect(enable).toBeDisabled();
    await consent.check();
    await enable.click();
    await expect(page.getByRole("button", { name: "Stop phone review and revoke file access" })).toBeVisible();
    expect((await (await request.get("/api/review")).json()).phoneReview.enabled).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Stop phone review and revoke file access" }).click();
    await expect(consent).toBeDisabled();
    const status = await (await request.get("/api/review")).json();
    expect(status.phoneReview.enabled).toBe(false);
    expect(status.permission.active).toBe(false);
  } finally {
    await request.post("/api/review/phone/end", { headers: { Origin: baseURL! }, data: { sessionId: link.sessionId } });
  }
});
async function openReview(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Client review", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Allow these three review folders" })
    .click();
}
async function preview(page: import("@playwright/test").Page) {
  await page
    .getByRole("button", { name: "Inspect exact source revisions" })
    .click();
  await expect(page.locator(".review-metric")).toBeVisible();
  await page
    .getByRole("button", { name: "Prepare three-slide preview" })
    .click();
  await expect(page.locator("article.review-slide")).toHaveCount(3);
  await expect(
    page.getByRole("checkbox", {
      name: "I approve these exact sources, slides and output destination.",
    }),
  ).toBeEnabled();
}
test("client-review preview, approval-only SDK execution, three rendered pages and separately approved artifact undo", async ({
  page,
  request,
  baseURL,
}) => {
  const errors: string[] = [];
  let browserCommits = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().endsWith("/api/review/commit")) browserCommits++;
  });
  expect(
    (
      await request.get("/api/review/images/before?digest=" + "0".repeat(64))
    ).status(),
  ).toBe(403);
  await openReview(page);
  await preview(page);
  await expect(page.locator(".review-metric h2")).toContainText("4.5%");
  await expect(page.locator(".review-metric")).toContainText("540 / 12,000");
  await expect(page.locator(".review-slide-2")).toContainText("Hypothesis");
  await expect(page.locator(".review-slide-3")).toContainText("Maya Chen");
  await expect(
    page.getByRole("button", { name: "Approve review for Fo" }),
  ).toBeDisabled();
  const accessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    accessibility.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await page
    .getByRole("checkbox", {
      name: "I approve these exact sources, slides and output destination.",
    })
    .check();
  await page.getByRole("button", { name: "Approve review for Fo" }).click();
  await expect(
    page.getByText("Approved. Waiting for Fo to call review.commit", {
      exact: false,
    }),
  ).toBeVisible();
  const status = await (await request.get("/api/review")).json();
  expect(status.jobs).toHaveLength(0);
  const plan = status.plans.find(
    (p: { state: string }) => p.state === "approved",
  );
  const client = new Client({
    name: "synthetic-browser-review-client",
    version: "1",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`)),
    );
    const result = await client.callTool({
      name: "review.commit",
      arguments: { id: plan.id },
    });
    expect(result.isError).not.toBe(true);
    await expect(
      page.getByRole("heading", { name: "Synthetic review · succeeded" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".review-renderings img")).toHaveCount(3);
    await expect
      .poll(() =>
        page
          .locator(".review-renderings img")
          .evaluateAll((images) =>
            images.every(
              (i) =>
                (i as HTMLImageElement).complete &&
                (i as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
    const shareButton = page.getByRole("button", { name: "Allow Fo to read generated attachments" });
    await expect(shareButton).toBeDisabled();
    const generated = (result.structuredContent as any).result;
    expect((await client.callTool({ name: "review.read_attachment", arguments: { id: generated.id, name: "review.pdf", offset: 0 } })).isError).toBe(true);
    await page.getByRole("checkbox", { name: "I allow Fo to read these exact generated attachment hashes." }).check();
    await shareButton.click();
    await expect(page.getByText("Fo may read these exact attachments until", { exact: false })).toBeVisible();
    expect((await client.callTool({ name: "review.read_attachment", arguments: { id: generated.id, name: "review.pdf", offset: 0 } })).isError).not.toBe(true);
    await page.getByRole("button", { name: "Review artifact removal" }).click();
    await expect(
      page.getByRole("heading", { name: "Review removal of generated copies" }),
    ).toBeVisible();
    await page
      .getByRole("checkbox", {
        name: "I approve these exact sources, slides and output destination.",
      })
      .check();
    await page.getByRole("button", { name: "Approve review for Fo" }).click();
    await expect(
      page.getByText("Approved. Waiting for Fo to call review.commit", {
        exact: false,
      }),
    ).toBeVisible();
    const current = await (await request.get("/api/review")).json(),
      undo = current.plans.find(
        (p: { state: string }) => p.state === "approved",
      );
    const removed = await client.callTool({
      name: "review.commit",
      arguments: { id: undo.id },
    });
    expect((removed.structuredContent as any).result.state).toBe("undone");
    await expect(
      page.getByRole("heading", { name: "Synthetic review · undone" }),
    ).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(browserCommits).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await client.close();
  }
});
test("revoke remains available during inspection; a late result cannot repopulate a new lease; repeated plans reset exact approval", async ({
  page,
}) => {
  await openReview(page);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    held = new Promise<void>((r) => {
      started = r;
    });
  await page.route("**/api/review/snapshot", async (route) => {
    const response = await route.fetch();
    started();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page
      .getByRole("button", { name: "Inspect exact source revisions" })
      .click();
    await held;
    await expect(
      page.getByRole("button", { name: "Revoke file access" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Revoke file access" }).click();
    await expect(
      page.getByRole("button", { name: "Allow these three review folders" }),
    ).toBeEnabled();
    await page
      .getByRole("button", { name: "Allow these three review folders" })
      .click();
    release();
    await page.unrouteAll({ behavior: "wait" });
    await expect(
      page.getByRole("button", { name: "Inspect exact source revisions" }),
    ).toBeEnabled();
    await expect(page.locator(".review-metric")).toHaveCount(0);
    await preview(page);
    await page
      .getByRole("checkbox", {
        name: "I approve these exact sources, slides and output destination.",
      })
      .check();
    await page.getByRole("button", { name: "Decline review plan" }).click();
    await page
      .getByRole("button", { name: "Prepare three-slide preview" })
      .click();
    await expect(
      page.getByRole("checkbox", {
        name: "I approve these exact sources, slides and output destination.",
      }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("button", { name: "Approve review for Fo" }),
    ).toBeDisabled();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
test("a delayed pending status cannot downgrade acknowledged approval or resurrect a declined review plan", async ({
  page,
}) => {
  await openReview(page);
  await preview(page);
  let releaseOld!: () => void,
    releaseNew!: () => void,
    started!: () => void,
    sent!: () => void;
  const oldGate = new Promise<void>((r) => {
      releaseOld = r;
    }),
    newGate = new Promise<void>((r) => {
      releaseNew = r;
    }),
    began = new Promise<void>((r) => {
      started = r;
    }),
    finished = new Promise<void>((r) => {
      sent = r;
    });
  let count = 0;
  await page.route("**/api/review", async (route) => {
    const n = ++count,
      response = await route.fetch();
    if (n === 1) {
      started();
      await oldGate;
    } else await newGate;
    await route.fulfill({ response });
    if (n === 1) sent();
  });
  try {
    await began;
    await page
      .getByRole("checkbox", {
        name: "I approve these exact sources, slides and output destination.",
      })
      .check();
    await page.getByRole("button", { name: "Approve review for Fo" }).click();
    await expect(
      page.getByText("Approved. Waiting for Fo to call review.commit", {
        exact: false,
      }),
    ).toBeVisible();
    releaseOld();
    await finished;
    await page.evaluate(
      () =>
        new Promise((r) =>
          requestAnimationFrame(() => requestAnimationFrame(r)),
        ),
    );
    await expect(
      page.getByText("Approved. Waiting for Fo to call review.commit", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Decline review plan" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Decline review plan" }).click();
    await expect(
      page.getByText("Approved. Waiting for Fo to call review.commit", {
        exact: false,
      }),
    ).toHaveCount(0);
    releaseNew();
    await page.unrouteAll({ behavior: "wait" });
    await expect(
      page.getByRole("button", { name: "Approve review for Fo" }),
    ).toHaveCount(0);
  } finally {
    releaseOld();
    releaseNew();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("each new plan must load its own comparison images and image failure cancels the approval checkbox", async ({
  page,
}) => {
  await openReview(page);
  await preview(page);
  await page.getByRole("button", { name: "Decline review plan" }).click();
  const held: Array<() => void> = [];
  await page.route("**/api/review/images/*", async (route) => {
    await new Promise<void>((resolve) => held.push(resolve));
    await route.fulfill({ response: await route.fetch() });
  });
  try {
    await page
      .getByRole("button", { name: "Prepare three-slide preview" })
      .click();
    await expect(page.locator("article.review-slide")).toHaveCount(3);
    await expect.poll(() => held.length).toBe(2);
    const checkbox = page.getByRole("checkbox", {
      name: "I approve these exact sources, slides and output destination.",
    });
    await expect(checkbox).toBeDisabled();
    held[0]();
    await expect
      .poll(() =>
        page
          .locator(".review-comparison img")
          .evaluateAll(
            (images) =>
              images.filter(
                (image) =>
                  (image as HTMLImageElement).complete &&
                  (image as HTMLImageElement).naturalWidth > 0,
              ).length,
          ),
      )
      .toBe(1);
    await expect(checkbox).toBeDisabled();
    held[1]();
    await expect(checkbox).toBeEnabled();
    await checkbox.check();
    await page.locator(".review-comparison img").first().dispatchEvent("error");
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Approve review for Fo" }),
    ).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText(
      "screenshot is unavailable",
    );
    await page.getByRole("button", { name: "Revoke file access" }).click();
    await expect(page.locator("article.review-slide")).toHaveCount(0);
  } finally {
    held.forEach((release) => release());
    await page.unrouteAll({ behavior: "wait" });
  }
});

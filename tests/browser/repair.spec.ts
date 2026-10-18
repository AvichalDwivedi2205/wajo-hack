import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test.beforeEach(async ({ request, baseURL }) => {
  const response = await request.delete("/api/permission", {
    headers: { Origin: baseURL! },
    data: {},
  });
  expect(response.ok()).toBe(true);
});

test("fixture repair, reload-persisted history, separately approved undo, denial, and revocation", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page).toHaveTitle(/Fo Reach/);
  await expect(
    page.getByText("No personal device is connected.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Allow sound-output inspection" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Sound is routed to Studio Display." }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /MacBook Speakers/ }).click();
  await page.getByRole("button", { name: "Review output change" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Approve & apply" }),
  ).toBeDisabled();
  await expect(
    dialog.getByText("Synthetic fixture only.", { exact: false }),
  ).toBeVisible();
  await dialog
    .getByRole("checkbox", { name: "I approve this specific change." })
    .check();
  await dialog.getByRole("button", { name: "Approve & apply" }).click();
  await expect(page.getByText("Fixture setting verified.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sound is routed to MacBook Speakers." }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Action history", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Use MacBook Speakers" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Review undo" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Use Studio Display" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Approve & undo" }),
  ).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: "I approve this specific undo." })
    .check();
  await dialog.getByRole("button", { name: "Approve & undo" }).click();
  await expect(
    page.getByRole("button", { name: "Undone", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Fix workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Sound is routed to Studio Display." }),
  ).toBeVisible();
  await page.getByRole("radio", { name: /Desk Headphones/ }).click();
  await page.getByRole("button", { name: "Review output change" }).click();
  await dialog.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Sound is routed to Studio Display." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await page.getByRole("button", { name: "Revoke device access" }).click();
  await expect(
    page.getByText("Currently off.", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Fix workspace" }).click();
  await expect(
    page.getByRole("button", { name: "Allow sound-output inspection" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile layout has no horizontal overflow and integration is candid", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Let’s get things working again." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Fo connection", exact: true })
    .click();
  await expect(
    page.getByText("Account state unknown", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("The existing Fo account connector is separate", {
      exact: false,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("all main screens pass automated WCAG A/AA checks; review dialog traps keyboard focus", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Allow sound-output inspection" })
    .waitFor();
  const audit = async () => {
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa"])
      .analyze();
    expect(
      results.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          summary: n.failureSummary,
        })),
      })),
    ).toEqual([]);
  };
  await audit();
  await page
    .getByRole("button", { name: "Allow sound-output inspection" })
    .click();
  await page.getByRole("radio", { name: /MacBook Speakers/ }).waitFor();
  await audit();
  await page.getByRole("radio", { name: /MacBook Speakers/ }).click();
  await page.getByRole("button", { name: "Review output change" }).click();
  const dialog = page.getByRole("dialog");
  await audit();
  await dialog
    .getByRole("button", { name: "Decline and close proposal" })
    .focus();
  await page.keyboard.press("Shift+Tab");
  await expect(
    dialog.getByRole("button", { name: "Decline", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole("button", { name: "Fo connection", exact: true })
    .click();
  await audit();
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await audit();
  await page
    .getByRole("button", { name: "Action history", exact: true })
    .click();
  await audit();
});

test("an MCP execution updates the open browser even when the browser lost its execute response", async ({
  page,
  baseURL,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Allow sound-output inspection" })
    .click();
  await page.getByRole("radio", { name: /MacBook Speakers/ }).click();
  await page.getByRole("button", { name: "Review output change" }).click();
  const dialog = page.getByRole("dialog");
  // The human approves through the actual interface. Lose only the subsequent
  // browser execution request; the separate MCP client must share that approval.
  await page.route("**/api/plans/*/execute", (route) => route.abort());
  await dialog
    .getByRole("checkbox", { name: "I approve this specific change." })
    .check();
  await dialog.getByRole("button", { name: "Approve & apply" }).click();
  await expect(
    dialog.getByRole("button", { name: "Approve & apply" }),
  ).toBeEnabled();
  const client = new Client({
    name: "browser-mcp-interoperability-test",
    version: "1",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`)),
    );
    const status = await client.callTool({
      name: "fo_fix_status",
      arguments: {},
    });
    const plans = (
      status.structuredContent as {
        result: { plans: { id: string; status: string }[] };
      }
    ).result.plans;
    const approved = plans.find((plan) => plan.status === "approved");
    expect(approved).toBeDefined();
    const result = await client.callTool({
      name: "fo_fix_execute_approved",
      arguments: { planId: approved!.id },
    });
    expect(result.isError).not.toBe(true);
    await expect(
      page.getByRole("heading", {
        name: "Sound is routed to MacBook Speakers.",
      }),
    ).toBeVisible();
    await expect(page.getByText("Fixture setting verified.")).toBeVisible();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review output change" }),
    ).toBeDisabled();
  } finally {
    await client.close();
  }
  await page.unroute("**/api/plans/*/execute");
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await page.getByRole("button", { name: "Revoke device access" }).click();
});

test("remote owner sign-in has no credential input and begins only the configured HTTPS authorization navigation", async ({
  page,
}) => {
  await page.route("**/api/auth", (route) =>
    route.fulfill({ status: 401, json: { code: "OWNER_SESSION_REQUIRED" } }),
  );
  await page.route("**/owner/auth/method", (route) =>
    route.fulfill({ json: { method: "oauth" } }),
  );
  await page.route("**/owner/auth/login", (route) => {
    expect(route.request().method()).toBe("POST");
    return route.fulfill({
      json: { authorizationUrl: "https://identity.fixture.invalid/authorize" },
    });
  });
  await page.route("https://identity.fixture.invalid/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>Synthetic identity-provider page. No account was contacted.</p>",
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Owner sign-in", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign in as owner" }).click();
  await expect(page).toHaveURL("https://identity.fixture.invalid/authorize");
});

test("cloud device-session interface never offers device permission grants or approval controls", async ({
  page,
  request,
}) => {
  const original = await (await request.get("/api/status")).json();
  await page.route("**/api/auth", (route) =>
    route.fulfill({
      json: {
        mode: "remote",
        authenticated: true,
        csrfToken: "synthetic-csrf",
      },
    }),
  );
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        ...original,
        mode: "unavailable",
        companion: "offline",
        approvalAuthority: "companion",
        deviceSession: { connected: false },
        permission: { active: false },
        actions: [],
        plans: [],
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Approvals stay on your device." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Allow sound-output inspection" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Allow inspection", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Revoke device access" }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("bearer profile uses a separate masked owner form and keeps the credential out of browser storage", async ({
  page,
}) => {
  let signedIn = false;
  const syntheticOwner = "synthetic_browser_owner_" + "b".repeat(43);
  await page.route("**/api/auth", (route) =>
    route.fulfill(
      signedIn
        ? {
            json: {
              mode: "remote",
              authenticated: true,
              csrfToken: "synthetic-csrf",
            },
          }
        : { status: 401, json: { code: "OWNER_SESSION_REQUIRED" } },
    ),
  );
  await page.route("**/owner/auth/method", (route) =>
    route.fulfill({ json: { method: "bearer" } }),
  );
  await page.route("**/owner/auth/login", (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers().authorization).toBeUndefined();
    expect(route.request().postDataJSON()).toEqual({
      credential: syntheticOwner,
    });
    signedIn = true;
    return route.fulfill({ json: { signedIn: true } });
  });
  await page.goto("/");
  const input = page.getByLabel("Owner access credential", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  await input.fill(syntheticOwner);
  await page.getByRole("button", { name: "Sign in as owner" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain(syntheticOwner);
  await expect(
    page.getByLabel("Owner access credential", { exact: true }),
  ).toHaveCount(0);
});

for (const method of ["bearer", "oauth"] as const)
  test(`${method}: an existing owner session can sign out and sign in again without reloading`, async ({
    page,
  }) => {
    await page.route("**/api/auth", (route) =>
      route.fulfill({
        json: {
          mode: "remote",
          authenticated: true,
          csrfToken: "synthetic-csrf",
        },
      }),
    );
    await page.route("**/owner/auth/logout", (route) =>
      route.fulfill({ json: { signedOut: true } }),
    );
    await page.route("**/owner/auth/method", (route) =>
      route.fulfill({ json: { method } }),
    );
    await page.goto("/");
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(
      page.getByRole("heading", { name: "Owner sign-in", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in as owner" }),
    ).toBeVisible();
    if (method === "bearer")
      await expect(
        page.getByLabel("Owner access credential", { exact: true }),
      ).toHaveAttribute("type", "password");
    else await expect(page.getByRole("textbox")).toHaveCount(0);
  });

for (const withheld of ["redacted", "truncated"] as const)
  test(`${withheld} history preserves the recorded count and never claims an empty journal`, async ({
    page,
    request,
  }) => {
    const original = await (await request.get("/api/status")).json();
    await page.route("**/api/status", (route) =>
      route.fulfill({
        json: {
          ...original,
          approvalAuthority: "companion",
          permission: { active: false },
          history: {
            redacted: withheld === "redacted",
            truncated: withheld === "truncated",
            actionCount: 4,
            planCount: 5,
            eventCount: 8,
          },
          actions: [],
          plans: [],
          events: [],
        },
      }),
    );
    await page.goto("/");
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Action history", exact: true })
      .click();
    await expect(
      page.getByText("4 recorded actions.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name:
          withheld === "redacted"
            ? "History details are withheld."
            : "History details exceed this session’s limit.",
      }),
    ).toBeVisible();
    await expect(page.getByText("A clean slate.", { exact: true })).toHaveCount(
      0,
    );
  });

test("a maximum-length unbroken synthetic device name wraps inside a mobile approval dialog", async ({
  page,
}) => {
  const deviceName = "S".repeat(256);
  await page.setViewportSize({ width: 390, height: 844 });
  // UI-only wire fixtures preserve the real fixture plan ID. No write is made.
  await page.route("**/api/inspect", async (route) => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.devices.find(
      (device: { id: string }) => device.id !== snapshot.outputId,
    ).name = deviceName;
    await route.fulfill({ response, json: snapshot });
  });
  await page.route("**/api/plans", async (route) => {
    const response = await route.fetch();
    const plan = await response.json();
    plan.title = `Use ${deviceName}`;
    plan.effect = `Switch sound output to ${deviceName}.`;
    await route.fulfill({ response, json: plan });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Allow sound-output inspection" })
    .click();
  await page.getByRole("radio", { name: new RegExp(deviceName) }).click();
  await page.getByRole("button", { name: "Review output change" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await dialog.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(dialog).not.toBeVisible();
});

test("Fo can execute only after approval-only review, with delayed polling, reload, separate undo and revocation", async ({
  page,
  baseURL,
}) => {
  const client = new Client({
    name: "synthetic-Fo-approval-only",
    version: "1",
  });
  const heldPolls: Array<() => void> = [];
  const approvedSeen = new Set<string>();
  let holdPolls = false,
    browserExecutions = 0;
  await page.route("**/api/status", async (route) => {
    if (holdPolls)
      await new Promise<void>((resolve) => heldPolls.push(resolve));
    const response = await route.fetch();
    const data = await response.json();
    for (const plan of data.plans ?? [])
      if (plan.status === "approved") approvedSeen.add(plan.id);
    await route.fulfill({ response, json: data });
  });
  page.on("request", (request) => {
    if (/\/api\/plans\/[^/]+\/execute$/.test(request.url()))
      browserExecutions++;
  });
  const releasePolls = () => {
    holdPolls = false;
    heldPolls.splice(0).forEach((release) => release());
  };
  const call = async (name: string, args = {}) =>
    client.callTool({ name, arguments: args });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`)),
    );
    await page.goto("/");
    await page
      .getByRole("button", { name: "Allow sound-output inspection" })
      .click();
    const inspected = (await call("fo_fix_inspect_output"))
      .structuredContent as {
      result: { outputId: string; devices: { id: string; name: string }[] };
    };
    const target = inspected.result.devices.find(
      (device) => device.id !== inspected.result.outputId,
    )!;
    const proposal = (
      await call("fo_fix_propose_repair", {
        recipe: "switch-output",
        deviceId: target.id,
      })
    ).structuredContent as { result: { id: string } };
    const plan = proposal.result;
    expect(
      (await call("fo_fix_execute_approved", { planId: plan.id })).isError,
    ).toBe(true);
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: `Use ${target.name}` }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Approve for Fo" }),
    ).toBeDisabled();
    await dialog
      .getByRole("checkbox", { name: "I approve this specific change." })
      .check();
    holdPolls = true;
    await dialog.getByRole("button", { name: "Approve for Fo" }).click();
    await expect(
      dialog.getByText("Approved. Waiting for Fo to execute this exact plan."),
    ).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Decline", exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByRole("checkbox")).toHaveCount(0);
    expect(browserExecutions).toBe(0);
    const before = (await call("fo_fix_inspect_output"))
      .structuredContent as typeof inspected;
    expect(before.result.outputId).toBe(inspected.result.outputId);
    releasePolls();
    await page.reload();
    await expect(
      dialog.getByText("Approved. Waiting for Fo to execute this exact plan."),
    ).toBeVisible();
    const executed = (
      await call("fo_fix_execute_approved", { planId: plan.id })
    ).structuredContent as {
      result: { id: string; state: string; verification: { status: string } };
    };
    expect(executed.result.state).toBe("succeeded");
    expect(executed.result.verification.status).toBe("passed");
    await expect(dialog).not.toBeVisible();
    await expect(page.getByText("Fixture setting verified.")).toBeVisible();
    const undo = (
      await call("fo_fix_propose_undo", { actionId: executed.result.id })
    ).structuredContent as typeof proposal;
    expect(
      (await call("fo_fix_execute_approved", { planId: undo.result.id }))
        .isError,
    ).toBe(true);
    await dialog
      .getByRole("checkbox", { name: "I approve this specific undo." })
      .check();
    await dialog.getByRole("button", { name: "Approve for Fo" }).click();
    await expect(
      dialog.getByText("Approved. Waiting for Fo to execute this exact plan."),
    ).toBeVisible();
    expect(
      (await call("fo_fix_execute_approved", { planId: undo.result.id }))
        .isError,
    ).not.toBe(true);
    await expect(dialog).not.toBeVisible();
    const restored = (await call("fo_fix_inspect_output"))
      .structuredContent as typeof inspected;
    expect(restored.result.outputId).toBe(inspected.result.outputId);
    const cancelled = (
      await call("fo_fix_propose_repair", {
        recipe: "switch-output",
        deviceId: target.id,
      })
    ).structuredContent as typeof proposal;
    await dialog
      .getByRole("checkbox", { name: "I approve this specific change." })
      .check();
    await dialog.getByRole("button", { name: "Approve for Fo" }).click();
    await expect(
      dialog.getByText("Approved. Waiting for Fo to execute this exact plan."),
    ).toBeVisible();
    await expect.poll(() => approvedSeen.has(cancelled.result.id)).toBe(true);
    holdPolls = true;
    await dialog.getByRole("button", { name: "Decline", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(
      (await call("fo_fix_execute_approved", { planId: cancelled.result.id }))
        .isError,
    ).toBe(true);
    expect(browserExecutions).toBe(0);
  } finally {
    releasePolls();
    await page.unrouteAll({ behavior: "wait" });
    await client.close();
  }
});

test("authenticated bearer owner sees exact UTC session and deployment deadlines with unknown account evidence", async ({
  page,
}) => {
  const expiresAt = Date.UTC(2026, 9, 18, 12, 15, 30, 123);
  const deploymentExpiresAt = Date.UTC(2026, 9, 18, 14, 0, 0, 456);
  await page.route("**/api/auth", (route) =>
    route.fulfill({
      json: {
        mode: "remote",
        authenticated: true,
        csrfToken: "synthetic-csrf",
        expiresAt,
        deploymentExpiresAt,
      },
    }),
  );
  await page.goto("/");
  await expect(
    page.getByText("Owner session ends", { exact: false }),
  ).toBeVisible();
  await expect(
    page.locator(
      `time[datetime="${new Date(deploymentExpiresAt).toISOString()}"]`,
    ),
  ).toHaveText("2026-10-18 14:00:00.456 UTC");
  await expect(
    page.getByText("No automatic renewal.", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Fo connection", exact: true })
    .click();
  await expect(
    page.getByText("Account state unknown", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("A successful tool call verifies that route at that time.", {
      exact: false,
    }),
  ).toBeVisible();
});

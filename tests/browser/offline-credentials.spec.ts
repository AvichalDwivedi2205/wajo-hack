import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

// All generated values in these tests are deterministic synthetic byte vectors.
// Never run the helper with real randomness, or retain secret-bearing captures.
test.use({ trace: "off", screenshot: "off", video: "off" });
// Managed cloud Chromium blocks file:// navigation. Fulfill the exact standalone
// file in memory at a loopback document URL; this adds no application endpoint.
const html = readFileSync(
  new URL("../../tools/offline-credentials.html", import.meta.url),
  "utf8",
);
const url = "http://127.0.0.1:4318/__offline-helper-test";
type Probe = {
  randomCalls: number;
  storageCalls: number;
  networkCalls: number;
  digestCompleted: number;
  fail: boolean;
  delay: boolean;
  release?: () => void;
};
async function instrument(page: Page) {
  await page.route(url, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.addInitScript(() => {
    const probe: Probe = {
      randomCalls: 0,
      storageCalls: 0,
      networkCalls: 0,
      digestCompleted: 0,
      fail: false,
      delay: false,
    };
    (window as unknown as { __foReachProbe: Probe }).__foReachProbe = probe;
    Object.defineProperty(crypto, "getRandomValues", {
      value: (bytes: Uint8Array) => {
        if (probe.fail) throw new Error("synthetic entropy failure");
        const offset = probe.randomCalls++ * 32;
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i + offset) % 256;
        return bytes;
      },
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, "digest", {
      value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
        if (probe.delay) {
          probe.delay = false;
          await new Promise<void>((resolve) => {
            probe.release = resolve;
          });
        }
        const result = await originalDigest(...args);
        probe.digestCompleted++;
        return result;
      },
    });
    for (const property of ["localStorage", "sessionStorage", "indexedDB"])
      Object.defineProperty(window, property, {
        get: () => {
          probe.storageCalls++;
          throw new Error("storage forbidden");
        },
      });
    Object.defineProperty(document, "cookie", {
      get: () => {
        probe.storageCalls++;
        return "";
      },
      set: () => {
        probe.storageCalls++;
      },
    });
    Object.defineProperty(window, "fetch", {
      value: () => {
        probe.networkCalls++;
        throw new Error("network forbidden");
      },
    });
    Object.defineProperty(navigator, "sendBeacon", {
      value: () => {
        probe.networkCalls++;
        return false;
      },
    });
  });
}
async function probe(page: Page) {
  return page.evaluate(() => {
    const value = (window as unknown as { __foReachProbe: Probe })
      .__foReachProbe;
    return {
      randomCalls: value.randomCalls,
      storageCalls: value.storageCalls,
      networkCalls: value.networkCalls,
    };
  });
}
test.afterEach(async ({ page }) => {
  await page
    .evaluate(() => {
      for (const id of ["owner", "mcp", "digests"]) {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) input.value = "";
      }
    })
    .catch(() => {});
});

test("offline click-only generation hashes exact synthetic strings, masks values and exports only digests without network/storage", async ({
  page,
}) => {
  await instrument(page);
  let httpRequests = 0;
  page.on("request", (request) => {
    if (
      /^https?:/.test(request.url()) &&
      !(request.url() === url && request.isNavigationRequest())
    )
      httpRequests++;
  });
  await page.goto(url);
  expect(await probe(page)).toEqual({
    randomCalls: 0,
    storageCalls: 0,
    networkCalls: 0,
  });
  await expect(page.locator("#owner")).toHaveValue("");
  await expect(page.locator("#export")).toBeDisabled();
  await page.locator("#generate").click();
  await expect(page.locator("#saved")).toBeEnabled();
  const fixtureOwner = Buffer.from(
    Array.from({ length: 32 }, (_, i) => i),
  ).toString("base64url");
  const fixtureMcp = Buffer.from(
    Array.from({ length: 32 }, (_, i) => i + 32),
  ).toString("base64url");
  const expected = `FO_FIX_OWNER_TOKEN_SHA256=${createHash("sha256").update(fixtureOwner).digest("hex")}\nFO_FIX_MCP_TOKEN_SHA256=${createHash("sha256").update(fixtureMcp).digest("hex")}\n`;
  // Boolean assertions keep even synthetic credential values out of failure logs.
  expect(
    await page
      .locator("#owner")
      .inputValue()
      .then((value) => value === fixtureOwner),
  ).toBe(true);
  expect(
    await page
      .locator("#mcp")
      .inputValue()
      .then((value) => value === fixtureMcp),
  ).toBe(true);
  expect(
    await page
      .locator("#digests")
      .inputValue()
      .then((value) => value === expected),
  ).toBe(true);
  await expect(page.locator("#owner")).toHaveAttribute("type", "password");
  await expect(page.locator("#mcp")).toHaveAttribute("type", "password");
  await expect(page.locator("#generate")).toBeDisabled();
  await page.locator("#reveal").click();
  await expect(page.locator("#owner")).toHaveAttribute("type", "text");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator("#owner")).toHaveAttribute("type", "password");
  await expect(page.locator("#export")).toBeDisabled();
  await page.locator("#saved").check();
  const exported = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await exported;
  expect(download.suggestedFilename()).toBe("fo-reach-digests.env");
  const contents = await readFile((await download.path())!, "utf8");
  expect(
    contents === expected &&
      !contents.includes(fixtureOwner) &&
      !contents.includes(fixtureMcp),
  ).toBe(true);
  expect(await probe(page)).toEqual({
    randomCalls: 2,
    storageCalls: 0,
    networkCalls: 0,
  });
  expect(httpRequests).toBe(0);
  await page.locator("#clear").click();
  await expect(page.locator("#owner")).toHaveValue("");
  await expect(page.locator("#digests")).toHaveValue("");
  await page.reload();
  expect(await probe(page)).toEqual({
    randomCalls: 0,
    storageCalls: 0,
    networkCalls: 0,
  });
});
test("helper fails closed on entropy failure and discards generation finishing after pagehide", async ({
  page,
}) => {
  await instrument(page);
  await page.goto(url);
  await page.evaluate(() => {
    (window as unknown as { __foReachProbe: Probe }).__foReachProbe.fail = true;
  });
  await page.locator("#generate").click();
  await expect(page.locator("#error")).toContainText("Generation failed");
  await expect(page.locator("#owner")).toHaveValue("");
  await expect(page.locator("#export")).toBeDisabled();
  await page.evaluate(() => {
    const p = (window as unknown as { __foReachProbe: Probe }).__foReachProbe;
    p.fail = false;
    p.delay = true;
  });
  await page.locator("#generate").click();
  await page.waitForFunction(
    () =>
      !!(window as unknown as { __foReachProbe: Probe }).__foReachProbe.release,
  );
  await page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    (window as unknown as { __foReachProbe: Probe }).__foReachProbe.release!();
  });
  await expect(page.locator("#generate")).toBeEnabled();
  await page.waitForFunction(
    () =>
      (window as unknown as { __foReachProbe: Probe }).__foReachProbe
        .digestCompleted === 2,
  );
  await expect(page.locator("#owner")).toHaveValue("");
  await expect(page.locator("#mcp")).toHaveValue("");
  await expect(page.locator("#digests")).toHaveValue("");
  await expect(page.locator("#export")).toBeDisabled();
});

import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

// All generated values in these tests are deterministic synthetic byte vectors.
// Never run the helper with real randomness, or retain secret-bearing captures.
test.use({ trace: "off", screenshot: "off", video: "off" });
// The loopback tests fulfill the exact standalone file in memory. A separate
// direct-file test exercises downloaded-file use where browser policy allows it.
const html = readFileSync(
  new URL("../../tools/offline-credentials.html", import.meta.url),
  "utf8",
);
const url = "http://127.0.0.1:4318/__offline-helper-test";
const fileUrl = new URL(
  "../../tools/offline-credentials.html",
  import.meta.url,
).href;
type Probe = {
  randomCalls: number;
  storageCalls: number;
  networkCalls: number;
  digestCompleted: number;
  digestSettled: number;
  digestCalls: number;
  fail: boolean;
  delay: boolean;
  rejectDelayed: boolean;
  delayCall?: number;
  repeatCall?: number;
  repeatOffset?: number;
  release?: () => void;
  releases: Array<() => void>;
};
declare global {
  interface Window {
    __foReachProbe: Probe;
  }
}
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
      digestSettled: 0,
      digestCalls: 0,
      fail: false,
      delay: false,
      rejectDelayed: false,
      releases: [],
    };
    window.__foReachProbe = probe;
    Object.defineProperty(crypto, "getRandomValues", {
      value: (bytes: Uint8Array) => {
        if (probe.fail) throw new Error("synthetic entropy failure");
        const call = probe.randomCalls++;
        const offset = (probe.repeatCall === call ? probe.repeatOffset! : call) * 32;
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i + offset) % 256;
        return bytes;
      },
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, "digest", {
      value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
        const call = ++probe.digestCalls;
        try {
          if (probe.delay || probe.delayCall === call) {
            const rejectDelayed = probe.rejectDelayed;
            probe.delay = probe.rejectDelayed = false;
            await new Promise<void>((resolve) => {
              probe.release = resolve;
              probe.releases.push(resolve);
            });
            if (rejectDelayed) throw new Error("synthetic digest failure");
          }
          const result = await originalDigest(...args);
          probe.digestCompleted++;
          return result;
        } finally {
          probe.digestSettled++;
        }
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
    const value = window.__foReachProbe;
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
      for (const id of ["owner", "mcp", "companion", "digests"]) {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) input.value = "";
      }
    })
    .catch(() => {});
});

for (const stage of [1, 2, 3])
  test(`Clear cancels generation while hash ${stage} is pending and discards its late result`, async ({
    page,
  }) => {
    await instrument(page);
    await page.goto(url);
    await page.evaluate((call) => {
      window.__foReachProbe.delayCall = call;
    }, stage);
    await page.locator("#generate").click();
    await page.waitForFunction(() => !!window.__foReachProbe.release);
    await expect(page.locator("#clear")).toBeEnabled();
    await page.locator("#clear").click();
    await expect(page.locator("#generate")).toBeEnabled();
    await expect(page.locator("#saved")).toBeDisabled();
    await expect(page.locator("#export")).toBeDisabled();
    await page.evaluate(() => window.__foReachProbe.release!());
    await page.waitForFunction(
      (settled) => window.__foReachProbe.digestSettled === settled,
      stage,
    );
    for (const id of ["owner", "mcp", "companion", "digests"])
      await expect(page.locator(`#${id}`)).toHaveValue("");
    await expect(page.locator("#owner")).toHaveAttribute("type", "password");
    await expect(page.locator("#mcp")).toHaveAttribute("type", "password");
    await expect(page.locator("#companion")).toHaveAttribute("type", "password");
    await expect(page.locator("#status")).toContainText("Cleared.");
    await expect(page.locator("#error")).toBeEmpty();
    await expect(page.locator("#export")).toBeDisabled();
    expect(await probe(page)).toEqual({
      randomCalls: 3,
      storageCalls: 0,
      networkCalls: 0,
    });
  });

for (const stage of [1, 2, 3]) for (const rejects of [false, true])
  test(`cancelled hash ${stage} ${rejects ? "failure" : "success"} cannot alter a newer pending generation`, async ({
    page,
  }) => {
    await instrument(page);
    await page.goto(url);
    await page.evaluate(({ rejectDelayed, stage }) => {
      const p = window.__foReachProbe;
      p.delayCall = stage;
      p.rejectDelayed = rejectDelayed;
    }, { rejectDelayed: rejects, stage });
    await page.locator("#generate").click();
    await page.waitForFunction(
      () => window.__foReachProbe.releases.length === 1,
    );
    await page.locator("#clear").click();
    await page.evaluate(() => {
      window.__foReachProbe.delay = true;
    });
    await page.locator("#generate").click();
    await page.waitForFunction(
      () => window.__foReachProbe.releases.length === 2,
    );
    await page.evaluate(() => window.__foReachProbe.releases[0]());
    await page.waitForFunction(
      settled => window.__foReachProbe.digestSettled === settled, stage,
    );
    await expect(page.locator("#generate")).toBeDisabled();
    await expect(page.locator("#clear")).toBeEnabled();
    await expect(page.locator("#error")).toBeEmpty();
    await expect(page.locator("#status")).toContainText("Generating locally.");
    await expect(page.locator("#owner")).toHaveValue("");
    await page.evaluate(() => window.__foReachProbe.releases[1]());
    await expect(page.locator("#saved")).toBeEnabled();
    const expectedOwner = Buffer.from(
      Array.from({ length: 32 }, (_, i) => i + 96),
    ).toString("base64url");
    const expectedMcp = Buffer.from(
      Array.from({ length: 32 }, (_, i) => i + 128),
    ).toString("base64url");
    const expectedCompanion = Buffer.from(
      Array.from({ length: 32 }, (_, i) => i + 160),
    ).toString("base64url");
    expect(
      await page.locator("#owner").inputValue()
        .then((value) => value === expectedOwner),
    ).toBe(true);
    expect(
      await page.locator("#mcp").inputValue()
        .then((value) => value === expectedMcp),
    ).toBe(true);
    expect(
      await page.locator("#companion").inputValue()
        .then((value) => value === expectedCompanion),
    ).toBe(true);
    await expect(page.locator("#error")).toBeEmpty();
    await expect(page.locator("#export")).toBeDisabled();
    expect(await probe(page)).toEqual({
      randomCalls: 6,
      storageCalls: 0,
      networkCalls: 0,
    });
    await page.locator("#clear").click();
  });

for (const stage of [1, 2, 3]) test(`a current hash ${stage} failure clears pending state and permits an explicit retry`, async ({ page }) => {
  await instrument(page);
  await page.goto(url);
  await page.evaluate(stage => {
    window.__foReachProbe.delayCall = stage;
    window.__foReachProbe.rejectDelayed = true;
  }, stage);
  await page.locator("#generate").click();
  await page.waitForFunction(() => !!window.__foReachProbe.release);
  await page.evaluate(() => window.__foReachProbe.release!());
  await expect(page.locator("#error")).toContainText("Generation failed.");
  await expect(page.locator("#status")).toHaveText(
    "No credentials are ready. You can try again.",
  );
  for (const id of ["owner", "mcp", "companion", "digests"])
    await expect(page.locator(`#${id}`)).toHaveValue("");
  await expect(page.locator("#generate")).toBeEnabled();
  await expect(page.locator("#clear")).toBeDisabled();
  await expect(page.locator("#export")).toBeDisabled();
  await page.locator("#generate").click();
  await expect(page.locator("#saved")).toBeEnabled();
  await expect(page.locator("#error")).toBeEmpty();
  await expect(page.locator("#status")).toContainText("Generated locally.");
  expect(await probe(page)).toEqual({
    randomCalls: 6,
    storageCalls: 0,
    networkCalls: 0,
  });
  await page.locator("#clear").click();
});

for (const pair of [[0, 1], [0, 2], [1, 2]]) test(`duplicate synthetic role pair ${pair.join("/")} fails before hashing or export`, async ({ page }) => {
  await instrument(page);
  await page.goto(url);
  await page.evaluate(([first, second]) => {
    window.__foReachProbe.repeatCall = second;
    window.__foReachProbe.repeatOffset = first;
  }, pair);
  await page.locator("#generate").click();
  await expect(page.locator("#error")).toContainText("Generation failed.");
  for (const id of ["owner", "mcp", "companion", "digests"])
    await expect(page.locator(`#${id}`)).toHaveValue("");
  expect(await page.evaluate(() => window.__foReachProbe.digestCalls)).toBe(0);
  expect(await probe(page)).toEqual({ randomCalls: 3, storageCalls: 0, networkCalls: 0 });
  await expect(page.locator("#export")).toBeDisabled();
  await expect(page.locator("#generate")).toBeEnabled();
});

test("downloaded standalone HTML works directly with synthetic bytes where file navigation is supported", async ({
  page,
}) => {
  await instrument(page);
  let networkRequests = 0;
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) networkRequests++;
  });
  try {
    await page.goto(fileUrl);
  } catch (error) {
    if (
      error instanceof Error &&
      /net::ERR_(?:ACCESS_DENIED|BLOCKED_BY_ADMINISTRATOR)/.test(error.message)
    ) {
      test.skip(
        true,
        "This browser's managed policy denies direct file navigation; loopback tests cover the exact file.",
      );
      return;
    }
    throw error;
  }
  expect(await probe(page)).toEqual({
    randomCalls: 0,
    storageCalls: 0,
    networkCalls: 0,
  });
  await expect(page.locator("#owner")).toHaveValue("");
  await page.locator("#generate").click();
  await expect(page.locator("#saved")).toBeEnabled();
  const expectedOwner = Buffer.from(
    Array.from({ length: 32 }, (_, i) => i),
  ).toString("base64url");
  const expectedMcp = Buffer.from(
    Array.from({ length: 32 }, (_, i) => i + 32),
  ).toString("base64url");
  const expectedCompanion = Buffer.from(
    Array.from({ length: 32 }, (_, i) => i + 64),
  ).toString("base64url");
  const expectedDigests = `FO_FIX_OWNER_TOKEN_SHA256=${createHash("sha256").update(expectedOwner).digest("hex")}\nFO_FIX_MCP_TOKEN_SHA256=${createHash("sha256").update(expectedMcp).digest("hex")}\nFO_FIX_COMPANION_TOKEN_SHA256=${createHash("sha256").update(expectedCompanion).digest("hex")}\n`;
  expect(
    await page.locator("#owner").inputValue()
      .then((value) => value === expectedOwner),
  ).toBe(true);
  expect(
    await page.locator("#mcp").inputValue()
      .then((value) => value === expectedMcp),
  ).toBe(true);
  expect(
    await page.locator("#companion").inputValue()
      .then((value) => value === expectedCompanion),
  ).toBe(true);
  await expect(page.locator("#owner")).toHaveAttribute("type", "password");
  await expect(page.locator("#mcp")).toHaveAttribute("type", "password");
  await expect(page.locator("#companion")).toHaveAttribute("type", "password");
  await page.locator("#saved").check();
  const exported = page.waitForEvent("download");
  await page.locator("#export").click();
  const contents = await readFile((await (await exported).path())!, "utf8");
  expect(
    contents === expectedDigests &&
      !contents.includes(expectedOwner) &&
      !contents.includes(expectedMcp) &&
      !contents.includes(expectedCompanion),
  ).toBe(true);
  await page.locator("#clear").click();
  for (const id of ["owner", "mcp", "companion", "digests"])
    await expect(page.locator(`#${id}`)).toHaveValue("");
  expect(await probe(page)).toEqual({
    randomCalls: 3,
    storageCalls: 0,
    networkCalls: 0,
  });
  expect(networkRequests).toBe(0);
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
  const fixtureCompanion = Buffer.from(
    Array.from({ length: 32 }, (_, i) => i + 64),
  ).toString("base64url");
  const expected = `FO_FIX_OWNER_TOKEN_SHA256=${createHash("sha256").update(fixtureOwner).digest("hex")}\nFO_FIX_MCP_TOKEN_SHA256=${createHash("sha256").update(fixtureMcp).digest("hex")}\nFO_FIX_COMPANION_TOKEN_SHA256=${createHash("sha256").update(fixtureCompanion).digest("hex")}\n`;
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
    await page.locator("#companion").inputValue()
      .then((value) => value === fixtureCompanion),
  ).toBe(true);
  expect(
    await page
      .locator("#digests")
      .inputValue()
      .then((value) => value === expected),
  ).toBe(true);
  await expect(page.locator("#owner")).toHaveAttribute("type", "password");
  await expect(page.locator("#mcp")).toHaveAttribute("type", "password");
  await expect(page.locator("#companion")).toHaveAttribute("type", "password");
  await expect(page.locator("#generate")).toBeDisabled();
  await page.locator("#reveal").click();
  await expect(page.locator("#owner")).toHaveAttribute("type", "text");
  await expect(page.locator("#companion")).toHaveAttribute("type", "text");
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(page.locator("#owner")).toHaveAttribute("type", "password");
  await expect(page.locator("#companion")).toHaveAttribute("type", "password");
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
      !contents.includes(fixtureMcp) &&
      !contents.includes(fixtureCompanion),
  ).toBe(true);
  expect(await probe(page)).toEqual({
    randomCalls: 3,
    storageCalls: 0,
    networkCalls: 0,
  });
  expect(httpRequests).toBe(0);
  await page.locator("#clear").click();
  for (const id of ["owner", "mcp", "companion", "digests"])
    await expect(page.locator(`#${id}`)).toHaveValue("");
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
    window.__foReachProbe.fail = true;
  });
  await page.locator("#generate").click();
  await expect(page.locator("#error")).toContainText("Generation failed");
  await expect(page.locator("#status")).toHaveText(
    "No credentials are ready. You can try again.",
  );
  await expect(page.locator("#owner")).toHaveValue("");
  await expect(page.locator("#export")).toBeDisabled();
  await page.evaluate(() => {
    const p = window.__foReachProbe;
    p.fail = false;
    p.delay = true;
  });
  await page.locator("#generate").click();
  await page.waitForFunction(
    () =>
      !!window.__foReachProbe.release,
  );
  await page.evaluate(() => {
    window.dispatchEvent(new Event("pagehide"));
    window.__foReachProbe.release!();
  });
  await expect(page.locator("#generate")).toBeEnabled();
  await page.waitForFunction(
    () =>
      window.__foReachProbe
        .digestCompleted === 1,
  );
  await expect(page.locator("#owner")).toHaveValue("");
  await expect(page.locator("#mcp")).toHaveValue("");
  await expect(page.locator("#companion")).toHaveValue("");
  await expect(page.locator("#digests")).toHaveValue("");
  await expect(page.locator("#export")).toBeDisabled();
});

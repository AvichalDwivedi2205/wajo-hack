import { defineConfig } from "@playwright/test";

if (process.platform !== "darwin" || !process.env.FO_FIX_REVIEW_ROOT)
  throw Error("Mac PPTX acceptance needs an explicit fresh FO_FIX_REVIEW_ROOT staged by review:pptx:setup.");
export default defineConfig({
  testDir: "./tests/native-browser",
  workers: 1,
  timeout: 120_000,
  use: {
    baseURL: "http://127.0.0.1:4319",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    launchOptions: { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
  },
  webServer: {
    command: "npm start -- --review-pptx",
    env: { FO_FIX_PORT: "4319", FO_FIX_DATA: ":memory:" },
    url: "http://127.0.0.1:4319/api/status",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

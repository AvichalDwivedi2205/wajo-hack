import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4318",
    browserName: "chromium",
    headless: true,
    trace: "retain-on-failure",
    launchOptions: {
      executablePath:
        process.env.CHROMIUM_PATH ??
        (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    },
  },
  webServer: {
    // Synthetic folder and private state under ignored .fo-fix; never ~/.fo-reach.
    command:
      'FO_FIX_DATA=:memory: npm run review:setup && mkdir -p .fo-fix/e2e-folders && FO_FIX_PORT=4318 FO_FIX_DATA=:memory: FO_REACH_HOME="$(pwd -P)/.fo-fix/e2e-state" npm start -- --review-demo --apps-demo --allow-folder "$(pwd -P)/.fo-fix/e2e-folders"',

    url: "http://127.0.0.1:4318/api/status",
    reuseExistingServer: false,
    timeout: 30_000,
  },
});

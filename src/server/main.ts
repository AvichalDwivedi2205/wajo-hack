import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import express from "express";
import { Store } from "../core/store.ts";
import { Engine } from "../core/engine.ts";
import { FixtureAdapter, MacOSAdapter } from "../companion/adapter.ts";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { SessionBroker } from "./session.ts";
import { FixError } from "../core/errors.ts";
import type { OwnerService } from "../core/service.ts";
import { AppEngine } from "../apps/engine.ts";
import { MacAppAdapter, FixtureAppAdapter } from "../apps/adapter.ts";
import { ReviewEngine } from "../review/engine.ts";
import { reviewDemoRoot } from "../review/setup.ts";
import {
  SyntheticReviewAdapter,
  KeynoteReviewAdapter,
  PptxReviewAdapter,
} from "../review/adapter.ts";
import { FolderEngine } from "../files/engine.ts";
import { configureRoots, folderArguments, type Root } from "../files/paths.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
let config;
try {
  config = loadConfig({
    ...process.env,
    ...(process.argv.includes("--remote") ? { FO_FIX_MODE: "remote" } : {}),
  });
} catch (error) {
  console.error(
    error instanceof FixError
      ? error.message
      : "Configuration could not be loaded.",
  );
  process.exit(2);
}
const port = config.port;
const real = process.argv.includes("--macos");
const nativeApps = process.argv.includes("--macos-apps");
const fixtureApps = process.argv.includes("--apps-demo");
const appsEnabled =
  nativeApps || fixtureApps || process.env.FO_FIX_APPS_ENABLED === "1";
if (
  (nativeApps &&
    (fixtureApps ||
      process.platform !== "darwin" ||
      config.mode !== "local")) ||
  (appsEnabled && config.mode === "remote" && config.backend !== "session") ||
  (appsEnabled && config.mode === "local" && !nativeApps && !fixtureApps)
) {
  console.error(
    "App opening requires an explicit local --macos-apps or synthetic --apps-demo route, or a remote session gateway. No automatic app installs or grants.",
  );
  process.exit(2);
}
const reviewNative = process.argv.includes("--review-native");
const reviewPptx = process.argv.includes("--review-pptx");
const reviewEnabled =
  reviewNative ||
  reviewPptx ||
  process.argv.includes("--review-demo") ||
  process.env.FO_FIX_REVIEW_ENABLED === "1";
if (
  (reviewNative || reviewPptx) &&
  ((reviewNative && !real) ||
    (reviewNative && reviewPptx) ||
    process.platform !== "darwin" ||
    config.mode !== "local" ||
    !process.env.FO_FIX_REVIEW_ROOT)
) {
  console.error(
    "Select one explicit Mac review route: --macos --review-native or --review-pptx, with local mode, FO_FIX_REVIEW_ROOT and the reviewed PDF helper. No permissions or credentials are configured automatically.",
  );
  process.exit(2);
}
if (reviewEnabled && config.mode === "remote" && config.backend !== "session") {
  console.error(
    "Remote client review requires the session gateway. File access and approval remain on the local companion.",
  );
  process.exit(2);
}
if (real && config.mode === "remote") {
  console.error(
    "Remote mode cannot colocate native hardware. Run the local Mac companion and a bounded device session.",
  );
  process.exit(2);
}
// Folder roots come only from this local command line or environment. The
// gateway merely relays folder tools (FO_FIX_FILES_ENABLED=1); it holds none.
const filesGateway = process.env.FO_FIX_FILES_ENABLED === "1";
const stateDirectory = resolve(process.env.FO_REACH_HOME || join(homedir(), ".fo-reach"));
let roots: Root[] = [];
try {
  const requested = folderArguments(process.argv.slice(2), process.env);
  if (requested.length && config.mode !== "local") {
    console.error("Allowed folders are configured only on the local Mac companion. The session gateway relays folder tools with FO_FIX_FILES_ENABLED=1 and holds no folder access.");
    process.exit(2);
  }
  if (filesGateway && (config.mode !== "remote" || config.backend !== "session")) {
    console.error("FO_FIX_FILES_ENABLED=1 is for the remote session gateway. On the Mac, allow folders with --allow-folder instead.");
    process.exit(2);
  }
  roots = configureRoots(requested, { home: homedir(), stateDirectory });
} catch (error) {
  console.error(error instanceof FixError ? error.message : "Allowed folders could not be configured.");
  process.exit(2);
}
const dataPath =
  process.env.FO_FIX_DATA ||
  join(root, ".fo-fix", real ? "macos.sqlite" : "fixture.sqlite");
const store =
  config.mode === "remote" && config.backend === "session"
    ? undefined
    : new Store(dataPath === ":memory:" ? dataPath : resolve(dataPath));
const engine = store
  ? new Engine(
      store,
      real
        ? new MacOSAdapter(join(root, "companion/macos/.build/fo-fix-audio"))
        : new FixtureAdapter(store),
    )
  : new SessionBroker(
      config.mode === "remote" ? config.deviceId! : "",
      Date.now,
      25_000,
      reviewEnabled,
      appsEnabled,
      filesGateway,
    );
const owner: OwnerService = engine;
const apps =
  store && appsEnabled
    ? new AppEngine(
        store,
        nativeApps
          ? new MacAppAdapter(
              join(root, "companion/macos/.build/fo-reach-apps"),
            )
          : new FixtureAppAdapter(),
      )
    : undefined;
if (apps) owner.apps = apps;
const review =
  reviewEnabled && store
    ? new ReviewEngine(
        store,
        reviewNative || reviewPptx
          ? resolve(process.env.FO_FIX_REVIEW_ROOT!)
          : reviewDemoRoot(root, dataPath),
        reviewPptx
          ? new PptxReviewAdapter()
          : reviewNative
            ? new KeynoteReviewAdapter(
                join(root, "companion/macos/.build/fo-review"),
              )
            : new SyntheticReviewAdapter(),
        Date.now,
        reviewNative
          ? join(root, "companion/macos/.build/fo-review")
          : undefined,
      )
    : undefined;
if (review) owner.review = review;
let files: FolderEngine | undefined;
try {
  files = store && roots.length ? new FolderEngine(store, roots, { stateDirectory }) : undefined;
} catch {
  console.error(`The private Fo Reach state folder ${JSON.stringify(stateDirectory)} could not hold the audit log. Folder tools were not started.`);
  process.exit(2);
}
if (files) {
  owner.files = files;
  console.error(`Folder tools: ${roots.length} allowed folder(s): ${roots.map((r) => JSON.stringify(r.path)).join(", ")}. Fo has no access until you choose "Allow Fo for 3 hours" in this Mac's Fo Reach interface. Audit: ${files.audit.path}`);
}
const { app, errors } = createApp(owner, port, { config });
let vite: Awaited<ReturnType<typeof import("vite").createServer>> | undefined;
if (process.argv.includes("--production") || real || config.mode === "remote") {
  app.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  });
  app.use(express.static(join(root, "dist")));
  app.get(
    /^(?!\/api\/|\/mcp|\/owner\/|\/session\/|\/.well-known\/).*/,
    (_req, res) => res.sendFile(join(root, "dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  vite = await createServer({
    root,
    server: { middlewareMode: true, hmr: false },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
app.use(errors);
const listenHost = config.mode === "remote" ? config.listenHost : "127.0.0.1";
const http = app.listen(port, listenHost, () =>
  console.error(
    `Fo Fix: http://${listenHost}:${port} · ${engine instanceof SessionBroker ? "remote session gateway — no local hardware" : engine.adapter.mode === "fixture" ? "SYNTHETIC FIXTURE — no real device attached" : "local macOS companion"} · ${config.mode} mode · MCP /mcp`,
  ),
);
http.requestTimeout = 15_000;
http.headersTimeout = 10_000;
http.keepAliveTimeout = 2_000;
let stopping: Promise<void> | undefined;
function stop() {
  return (stopping ??= (async () => {
    const closed = new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    // Keep the exclusive journal lock until active writes have been verified
    // and persisted, and their HTTP responses have completed.
    await Promise.all([
      closed,
      engine.shutdown(),
      review?.shutdown(),
      apps?.shutdown(),
      files?.shutdown(),
    ]);
    await vite?.close();
    store?.close();
  })());
}
process.once("SIGINT", () => {
  void stop();
});
process.once("SIGTERM", () => {
  void stop();
});

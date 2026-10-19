import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { OwnerService } from "../core/service.ts";
import { FixError } from "../core/errors.ts";
import { createMcpServer } from "./mcp.ts";
import { repairRequest } from "../shared/requests.ts";
import { RemoteAuth, type AuthOptions } from "./auth.ts";
import type { ServerConfig } from "./config.ts";
import { SessionBroker, mountSessionRoutes } from "./session.ts";
import { configurationDiagnostics } from "./diagnostics.ts";
import { BearerAuth } from "./bearer-auth.ts";
import { trustedProxyCheck } from "./proxy.ts";
import { mountReview } from "../review/routes.ts";
import { mountApps } from "../apps/routes.ts";
import { AttachmentDownloads } from "./attachment-download.ts";
import { MAX_MCP_REQUEST_BYTES } from "../shared/limits.ts";
import { mountFolders } from "../files/routes.ts";

export function createApp(
  engine: OwnerService,
  port: number,
  options: { config?: ServerConfig; auth?: AuthOptions } = {},
) {
  const app = express();
  app.disable("x-powered-by");
  const config = options.config ?? { mode: "local" as const, port };
  const auth =
    config.mode === "remote"
      ? config.authMode === "bearer"
        ? new BearerAuth(config, options.auth?.clock)
        : new RemoteAuth(config, options.auth)
      : undefined;
  const trustedProxy =
    config.mode === "remote"
      ? trustedProxyCheck(config.trustedProxyAddresses)
      : undefined;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  if (config.mode === "remote") {
    hosts.clear();
    hosts.add(new URL(config.origin).host);
    origins.clear();
    origins.add(config.origin);
  }
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cache-Control", "no-store");
    if (config.mode === "remote") {
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      const peer = req.socket.remoteAddress;
      if (
        !trustedProxy!(peer) ||
        req.headers["x-forwarded-proto"] !== "https"
      ) {
        res.status(403).json({
          code: "HTTPS_PROXY_REQUIRED",
          message:
            "Remote mode requires HTTPS through an explicitly trusted proxy address.",
        });
        return;
      }
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    if (!hosts.has(req.headers.host ?? "")) {
      res.status(403).json({
        code: "HOST_DENIED",
        message: "The request host is not configured for this deployment.",
      });
      return;
    }
    if (req.headers.origin && !origins.has(req.headers.origin)) {
      res.status(403).json({
        code: "ORIGIN_DENIED",
        message: "Cross-origin access is not allowed.",
      });
      return;
    }
    next();
  });
  const downloads = config.mode === "remote" && engine instanceof SessionBroker && (engine.review || engine.files)
    ? new AttachmentDownloads(engine, config.origin, options.auth?.clock) : undefined;
  if (downloads) app.head("/attachments/:token", (_req, res) => { res.sendStatus(405); });
  if (downloads) app.get("/attachments/:token", async (req, res) => {
    const file = await downloads.consume(req.params.token);
    res.attachment(file.name);
    res.type(file.contentType).send(file.bytes);
  });
  // Authenticate machine and owner APIs before parsing their request bodies.
  if (auth) {
    app.use("/mcp", auth.bearer("mcp"));
    app.use("/session", auth.bearer("companion"));
    app.use("/api", auth.owner);
    app.use("/session/result", express.json({ limit: "512kb" }));
  }
  // Only authenticated (remote) or loopback MCP may carry one bounded folder write.
  app.use("/mcp", express.json({ limit: MAX_MCP_REQUEST_BYTES }));
  app.use(express.json({ limit: "16kb" }));
  if (auth) {
    auth.mount(app, async () => {
      if (engine instanceof SessionBroker) engine.disconnect();
      else await engine.revokePermission();
    });
    if (engine instanceof SessionBroker) mountSessionRoutes(app, engine, auth);
  } else
    app.get("/api/auth", (_req, res) =>
      res.json({ mode: "local", authenticated: true }),
    );
  const human: RequestHandler = (req, res, next) => {
    if (
      !origins.has(req.headers.origin ?? "") ||
      (req.headers["sec-fetch-site"] &&
        req.headers["sec-fetch-site"] !== "same-origin")
    ) {
      res.status(403).json({
        code: "LOCAL_REVIEW_REQUIRED",
        message: "Use the local Fo Reach interface to allow or approve access.",
      });
      return;
    }
    next();
  };
  app.use("/api", (_req, res, next) => {
    res.locals.approvalAuthority =
      engine instanceof SessionBroker ? "companion" : "here";
    next();
  });
  const id = z.object({ id: z.uuid() }).strict();
  mountReview(app, engine, config, human);
  mountApps(app, engine, config.mode === "local", human);
  mountFolders(app, engine, config.mode === "local", human);
  const empty = z.object({}).strict();
  app.get("/api/status", async (_req, res) =>
    res.json({
      ...(await engine.status()),
      approvalAuthority: res.locals.approvalAuthority,
    }),
  );
  app.get("/api/diagnostics", (_req, res) =>
    res.json(
      configurationDiagnostics({ ...process.env, FO_FIX_MODE: config.mode }),
    ),
  );
  app.post("/api/permission", human, async (req, res) => {
    empty.parse(req.body);
    res.json(await engine.grantPermission());
  });
  app.delete("/api/permission", human, async (req, res) => {
    empty.parse(req.body);
    res.json(await engine.revokePermission());
  });
  app.post("/api/inspect", async (req, res) => {
    empty.parse(req.body);
    res.json(await engine.inspect());
  });
  app.post("/api/plans", async (req, res) => {
    const data = repairRequest.parse(req.body);
    res.json(await engine.propose(data.recipe, data.deviceId));
  });
  app.post("/api/plans/:id/approve", human, async (req, res) => {
    const { id: planId } = id.parse(req.params);
    const { digest } = z
      .object({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.body);
    res.json(await engine.approve(planId, digest));
  });
  app.post("/api/plans/:id/deny", human, async (req, res) => {
    const { id: planId } = id.parse(req.params);
    empty.parse(req.body);
    res.json(await engine.deny(planId));
  });
  app.post("/api/plans/:id/execute", async (req, res) => {
    const { id: planId } = id.parse(req.params);
    empty.parse(req.body);
    res.json(await engine.execute(planId));
  });
  app.post("/api/actions/:id/undo", async (req, res) => {
    const { id: actionId } = id.parse(req.params);
    empty.parse(req.body);
    res.json(await engine.proposeUndo(actionId));
  });
  app.post("/mcp", async (req, res, next) => {
    const server = createMcpServer(engine, downloads);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      next(e);
    }
  });
  app.all("/mcp", (_req, res) =>
    res.status(405).json({ message: "Use MCP Streamable HTTP POST." }),
  );
  const errors: ErrorRequestHandler = (e, _req, res, _next) => {
    if (res.headersSent) {
      _next(e);
      return;
    }
    if (e?.type === "entity.too.large")
      res.status(413).json({
        code: "REQUEST_TOO_LARGE",
        message:
          e.limit === 512 * 1024
            ? "Session results are limited to 512 KiB."
            : e.limit === MAX_MCP_REQUEST_BYTES
              ? "MCP requests are limited to 1 MiB."
              : "Requests are limited to 16 KiB.",
      });
    else if (e instanceof FixError)
      res.status(e.status).json({ code: e.code, message: e.message });
    else if (e instanceof z.ZodError || e instanceof SyntaxError)
      res.status(400).json({
        code: "INVALID_REQUEST",
        message:
          "Invalid request. Use the documented schema and supported actions.",
      });
    else
      res.status(500).json({
        code: "COMPANION_ERROR",
        message:
          "The companion could not complete the request. Check the local helper and inspect again.",
      });
  };
  // Installed last by main.ts after the static/Vite middleware.
  return { app, errors };
}

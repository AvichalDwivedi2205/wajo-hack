import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import type { BearerRemoteConfig } from "./config.ts";
import type { Identity, OwnerAuthentication } from "./auth.ts";
import { ownerCookie } from "./auth.ts";
import { invariant } from "../core/errors.ts";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
const credential = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
function equal(a: string, b: string) {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function ownerSessionId(req: Request) {
  const entries = (req.headers.cookie ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith(`${ownerCookie}=`));
  return entries.length === 1 ? entries[0].slice(ownerCookie.length + 1) : "";
}
function setOwnerCookie(res: Response, value: string, maxAge: number) {
  res.cookie(ownerCookie, value, {
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge,
  });
}

// Explicit Fo static-bearer profile, not an OAuth authorization server.
// Only SHA-256 digests are configured. No credentials are generated or logged.
export class BearerAuth implements OwnerAuthentication {
  private sessions = new Map<string, { csrf: string; expiresAt: number }>();
  private loginWindow = { start: 0, count: 0 };
  constructor(
    readonly config: BearerRemoteConfig,
    private clock = Date.now,
  ) {}
  private unexpired() {
    invariant(
      this.clock() < this.config.accessExpiresAt,
      "ACCESS_EXPIRED",
      "This deployment's access window has ended.",
      401,
    );
  }
  private sameOrigin(req: Request) {
    invariant(
      req.headers.origin === this.config.origin &&
        (!req.headers["sec-fetch-site"] ||
          req.headers["sec-fetch-site"] === "same-origin"),
      "ORIGIN_DENIED",
      "Use the same-origin owner interface.",
      403,
    );
  }
  private verify(value: string, digest: string | undefined) {
    this.unexpired();
    invariant(
      credential.safeParse(value).success &&
        !!digest &&
        equal(hash(value), digest),
      "UNAUTHORIZED",
      "A valid credential for this authority is required.",
      401,
    );
  }
  bearer =
    (authority: "mcp" | "companion"): RequestHandler =>
    (req, res, next) => {
      try {
        const header = req.headers.authorization;
        invariant(
          typeof header === "string" && /^Bearer [^\s]+$/i.test(header),
          "UNAUTHORIZED",
          "A bearer credential is required.",
          401,
        );
        this.verify(
          header.slice(7),
          authority === "mcp"
            ? this.config.mcpTokenHash
            : this.config.companionTokenHash,
        );
        res.locals.identity = {
          subject: "single-owner",
          clientId: authority,
          expiresAt: this.config.accessExpiresAt,
        } satisfies Identity;
        next();
      } catch (error) {
        res.setHeader("WWW-Authenticate", `Bearer realm="fo-fix-${authority}"`);
        next(error);
      }
    };
  owner: RequestHandler = (req, res, next) => {
    try {
      this.unexpired();
      invariant(
        !req.headers.authorization,
        "OWNER_SESSION_REQUIRED",
        "Use the separate owner browser sign-in.",
        401,
      );
      for (const [id, session] of this.sessions)
        if (session.expiresAt <= this.clock()) this.sessions.delete(id);
      const session = this.sessions.get(hash(ownerSessionId(req)));
      invariant(
        session && session.expiresAt > this.clock(),
        "OWNER_SESSION_REQUIRED",
        "Sign in to the owner interface.",
        401,
      );
      if (!["GET", "HEAD"].includes(req.method)) {
        this.sameOrigin(req);
        invariant(
          typeof req.headers["x-fofix-csrf"] === "string" &&
            equal(req.headers["x-fofix-csrf"], session.csrf),
          "CSRF_REQUIRED",
          "Refresh the owner session before changing state.",
          403,
        );
      }
      res.locals.ownerSession = session;
      next();
    } catch (error) {
      next(error);
    }
  };
  mount(app: Express, revoke: () => unknown | Promise<unknown>) {
    app.get("/owner/auth/method", (_req, res) =>
      res.json({ method: "bearer" }),
    );
    app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) =>
      res.status(404).json({
        code: "EXPLICIT_BEARER_PROFILE",
        message: "Configure this connection's bearer credential explicitly.",
      }),
    );
    app.post("/owner/auth/login", (req, res) => {
      this.sameOrigin(req);
      this.unexpired();
      invariant(
        !req.headers.authorization && Object.keys(req.query).length === 0,
        "OWNER_SESSION_REQUIRED",
        "Use the separate owner sign-in form.",
        401,
      );
      if (this.clock() - this.loginWindow.start >= 60_000)
        this.loginWindow = { start: this.clock(), count: 0 };
      invariant(
        ++this.loginWindow.count <= 10,
        "LOGIN_RATE_LIMITED",
        "Too many sign-in attempts. Wait a minute.",
        429,
      );
      const data = z.object({ credential }).strict().parse(req.body);
      this.verify(data.credential, this.config.ownerTokenHash);
      for (const [id, session] of this.sessions)
        if (session.expiresAt <= this.clock()) this.sessions.delete(id);
      invariant(
        this.sessions.size < 50,
        "AUTH_BUSY",
        "Too many owner sessions. Sign out another session.",
        429,
      );
      const id = opaque(),
        csrf = opaque(),
        expiresAt = Math.min(
          this.clock() + 15 * 60_000,
          this.config.accessExpiresAt,
        );
      this.sessions.set(hash(id), { csrf, expiresAt });
      setOwnerCookie(res, id, expiresAt - this.clock());
      res.json({ signedIn: true });
    });
    app.get("/api/auth", this.owner, (_req, res) =>
      res.json({
        mode: "remote",
        authenticated: true,
        csrfToken: res.locals.ownerSession.csrf,
        expiresAt: res.locals.ownerSession.expiresAt,
        deploymentExpiresAt: this.config.accessExpiresAt,
      }),
    );
    app.post("/owner/auth/logout", this.owner, async (req, res) => {
      this.sessions.delete(hash(ownerSessionId(req)));
      setOwnerCookie(res, "", 0);
      await revoke();
      res.json({ signedOut: true });
    });
  }
}

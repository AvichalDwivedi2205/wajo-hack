import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import type { Express, Request, RequestHandler, Response } from "express";
import type { OAuthRemoteConfig } from "./config.ts";
import { FixError, invariant } from "../core/errors.ts";
import { boundedJson } from "../shared/bounded-json.ts";

export interface OwnerAuthentication {
  bearer(authority: "mcp" | "companion"): RequestHandler;
  owner: RequestHandler;
  mount(app: Express, revoke: () => unknown | Promise<unknown>): void;
}

export type Authority = "mcp" | "owner" | "companion";
export type Identity = { subject: string; clientId: string; expiresAt: number };
export type AuthOptions = {
  key?: JWTVerifyGetKey;
  fetch?: typeof fetch;
  clock?: () => number;
};
const scopeFor = {
  mcp: "fofix:mcp",
  owner: "fofix:owner",
  companion: "fofix:companion",
} as const;
export const ownerCookie = "__Host-fofix_owner";
const loginCookie = "__Host-fofix_login";
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function cookie(req: Request, name: string) {
  const matches = (req.headers.cookie ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p.startsWith(`${name}=`));
  return matches.length === 1 ? matches[0].slice(name.length + 1) : "";
}
function setCookie(
  res: Response,
  name: string,
  value: string,
  maxAge: number,
  sameSite: "lax" | "strict",
) {
  res.cookie(name, value, {
    secure: true,
    httpOnly: true,
    sameSite,
    path: "/",
    maxAge,
  });
}

export class RemoteAuth implements OwnerAuthentication {
  private key: JWTVerifyGetKey;
  private clock: () => number;
  private fetcher: typeof fetch;
  private pending = new Map<string, { verifier: string; expiresAt: number }>();
  private sessions = new Map<
    string,
    { accessToken: string; csrf: string; expiresAt: number }
  >();
  constructor(
    readonly config: OAuthRemoteConfig,
    options: AuthOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.fetcher = options.fetch ?? fetch;
    this.key =
      options.key ??
      createRemoteJWKSet(new URL(config.jwksUrl), {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
        cacheMaxAge: 5 * 60_000,
        [customFetch]: async (url, init) => {
          const response = await this.fetcher(url, {
            ...init,
            redirect: "error",
            signal: AbortSignal.timeout(5000),
          });
          if (response.status !== 200) {
            await response.body?.cancel();
            return new Response(null, { status: response.status });
          }
          return Response.json(await boundedJson(response, 128 * 1024));
        },
      });
  }
  audience(authority: Authority) {
    return `${this.config.origin}/${authority === "mcp" ? "mcp" : authority === "owner" ? "owner" : "session"}`;
  }
  async verify(token: string, authority: Authority): Promise<Identity> {
    invariant(
      token.length > 0 && token.length <= 16_384,
      "UNAUTHORIZED",
      "A valid access token is required.",
      401,
    );
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.key, {
        issuer: this.config.issuer,
        audience: this.audience(authority),
        algorithms: ["RS256", "ES256"],
        typ: "at+jwt",
        requiredClaims: ["sub", "exp", "iat", "client_id", "scope", "jti"],
        currentDate: new Date(this.clock()),
        clockTolerance: 0,
      });
      payload = verified.payload;
    } catch {
      throw new FixError(
        "UNAUTHORIZED",
        "The access token is invalid, expired or not intended for this resource.",
        401,
      );
    }
    invariant(
      payload.aud === this.audience(authority),
      "UNAUTHORIZED",
      "Tokens must have exactly one intended resource audience.",
      401,
    );
    const clientId =
      authority === "owner"
        ? this.config.ownerClientId
        : authority === "mcp"
          ? this.config.mcpClientId
          : this.config.companionClientId;
    invariant(
      !!clientId &&
        payload.client_id === clientId &&
        payload.sub === this.config.ownerSubject,
      "FORBIDDEN",
      "This identity is not authorized for this authority.",
      403,
    );
    const scopes =
      typeof payload.scope === "string"
        ? payload.scope.split(" ").filter(Boolean)
        : [];
    invariant(
      scopes.includes(scopeFor[authority]) &&
        Object.entries(scopeFor).every(
          ([role, scope]) => role === authority || !scopes.includes(scope),
        ),
      "FORBIDDEN",
      "This token does not have an isolated authority scope.",
      403,
    );
    invariant(
      typeof payload.jti === "string" &&
        payload.jti.length > 0 &&
        payload.jti.length <= 1024 &&
        typeof payload.exp === "number" &&
        typeof payload.iat === "number" &&
        payload.iat <= this.clock() / 1000 + 5 &&
        payload.exp - payload.iat <= 3600,
      "UNAUTHORIZED",
      "Access tokens must be short lived and uniquely identified.",
      401,
    );
    return {
      subject: payload.sub!,
      clientId: String(payload.client_id),
      expiresAt: payload.exp * 1000,
    };
  }
  bearer =
    (authority: "mcp" | "companion"): RequestHandler =>
    async (req, res, next) => {
      const header = req.headers.authorization;
      try {
        invariant(
          typeof header === "string" && /^Bearer [^\s]+$/i.test(header),
          "UNAUTHORIZED",
          "A bearer access token is required.",
          401,
        );
        res.locals.identity = await this.verify(header.slice(7), authority);
        next();
      } catch (error) {
        if (authority === "mcp")
          res.setHeader(
            "WWW-Authenticate",
            `Bearer resource_metadata="${this.config.origin}/.well-known/oauth-protected-resource/mcp", scope="fofix:mcp"`,
          );
        next(error);
      }
    };
  private prune() {
    for (const [key, state] of this.pending)
      if (state.expiresAt <= this.clock()) this.pending.delete(key);
    for (const [key, state] of this.sessions)
      if (state.expiresAt <= this.clock()) this.sessions.delete(key);
  }
  sameOrigin(req: Request) {
    invariant(
      req.headers.origin === this.config.origin &&
        (!req.headers["sec-fetch-site"] ||
          req.headers["sec-fetch-site"] === "same-origin"),
      "ORIGIN_DENIED",
      "Use the same-origin owner interface.",
      403,
    );
  }
  owner: RequestHandler = async (req, res, next) => {
    try {
      this.prune();
      // Bearer tokens never authenticate owner routes. The BFF session is
      // established only by the independent owner OAuth client and PKCE flow.
      invariant(
        !req.headers.authorization,
        "OWNER_SESSION_REQUIRED",
        "Use the owner browser sign-in.",
        401,
      );
      const session = this.sessions.get(hash(cookie(req, ownerCookie)));
      invariant(
        session && session.expiresAt > this.clock(),
        "OWNER_SESSION_REQUIRED",
        "Sign in to the owner interface.",
        401,
      );
      res.locals.identity = await this.verify(session.accessToken, "owner");
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
    app.get("/owner/auth/method", (_req, res) => res.json({ method: "oauth" }));
    app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) =>
      res.json({
        resource: this.audience("mcp"),
        authorization_servers: [this.config.issuer],
        scopes_supported: [scopeFor.mcp],
        bearer_methods_supported: ["header"],
      }),
    );
    app.post("/owner/auth/login", (req, res) => {
      this.sameOrigin(req);
      this.prune();
      invariant(
        this.pending.size < 100,
        "AUTH_BUSY",
        "Too many pending sign-ins. Try again shortly.",
        429,
      );
      const state = opaque(),
        verifier = opaque();
      this.pending.set(hash(state), {
        verifier,
        expiresAt: this.clock() + 10 * 60_000,
      });
      setCookie(res, loginCookie, state, 10 * 60_000, "lax");
      const url = new URL(this.config.authorizationUrl);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: this.config.ownerClientId,
        redirect_uri: `${this.config.origin}/owner/auth/callback`,
        scope: "openid fofix:owner",
        resource: this.audience("owner"),
        state,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update(verifier)
          .digest("base64url"),
        prompt: "login",
      }).toString();
      res.json({ authorizationUrl: url.toString() });
    });
    app.get("/owner/auth/callback", async (req, res) => {
      this.prune();
      const state = typeof req.query.state === "string" ? req.query.state : "";
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const saved = this.pending.get(hash(state));
      invariant(
        state.length <= 128 &&
          state.length > 0 &&
          equal(state, cookie(req, loginCookie)) &&
          saved &&
          code.length > 0 &&
          code.length <= 4096,
        "AUTH_CALLBACK_INVALID",
        "The owner sign-in could not be verified. Start again.",
        403,
      );
      this.pending.delete(hash(state)); // A code/state is never exchanged twice.
      setCookie(res, loginCookie, "", 0, "lax");
      try {
        const response = await this.fetcher(this.config.tokenUrl, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(5000),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: this.config.ownerClientId,
            redirect_uri: `${this.config.origin}/owner/auth/callback`,
            code_verifier: saved.verifier,
            resource: this.audience("owner"),
          }),
        });
        invariant(
          response.ok,
          "AUTH_EXCHANGE_FAILED",
          "Owner sign-in could not complete.",
          401,
        );
        const data = (await boundedJson(response, 32_768)) as {
          token_type?: string;
          access_token?: string;
        };
        invariant(
          data.token_type?.toLowerCase() === "bearer" &&
            typeof data.access_token === "string",
          "AUTH_EXCHANGE_FAILED",
          "Owner sign-in could not complete.",
          401,
        );
        const identity = await this.verify(data.access_token, "owner");
        invariant(
          this.sessions.size < 50,
          "AUTH_BUSY",
          "Too many owner sessions. Sign out another session.",
          429,
        );
        const sessionId = opaque(),
          csrf = opaque();
        const expiresAt = Math.min(
          identity.expiresAt,
          this.clock() + 15 * 60_000,
        );
        this.sessions.set(hash(sessionId), {
          accessToken: data.access_token,
          csrf,
          expiresAt,
        });
        setCookie(
          res,
          ownerCookie,
          sessionId,
          expiresAt - this.clock(),
          "strict",
        );
        res.redirect(303, "/");
      } catch {
        throw new FixError(
          "AUTH_EXCHANGE_FAILED",
          "Owner sign-in failed. Check the approved identity-provider configuration.",
          401,
        );
      }
    });
    app.get("/api/auth", this.owner, (_req, res) =>
      res.json({
        mode: "remote",
        authenticated: true,
        csrfToken: res.locals.ownerSession.csrf,
        expiresAt: res.locals.ownerSession.expiresAt,
      }),
    );
    app.post("/owner/auth/logout", this.owner, async (req, res) => {
      this.sessions.delete(hash(cookie(req, ownerCookie)));
      setCookie(res, ownerCookie, "", 0, "strict");
      await revoke();
      res.json({ signedOut: true });
    });
  }
}

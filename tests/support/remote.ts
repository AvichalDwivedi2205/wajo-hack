// Ephemeral signing keys and tokens exist only for these synthetic tests.
// No production credentials or provider accounts are created or contacted;
// test signing material is neither logged nor persisted.
import {
  generateKeyPair,
  exportJWK,
  createLocalJWKSet,
  SignJWT,
  type JWTPayload,
} from "jose";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import type {
  OAuthRemoteConfig,
  RemoteConfig,
} from "../../src/server/config.ts";
import type { Authority } from "../../src/server/auth.ts";
import { createApp } from "../../src/server/app.ts";
import { Store } from "../../src/core/store.ts";
import { Engine } from "../../src/core/engine.ts";
import { FixtureAdapter } from "../../src/companion/adapter.ts";
import type { OwnerService } from "../../src/core/service.ts";

export async function identityFixture(
  backend: "fixture" | "session" = "fixture",
) {
  const config: OAuthRemoteConfig = {
    mode: "remote",
    authMode: "oauth",
    listenHost: "127.0.0.1",
    trustedProxyAddresses: ["127.0.0.1", "::1"],
    port: 4310,
    origin: "https://fix.fixture.invalid",
    issuer: "https://identity.fixture.invalid/",
    jwksUrl: "https://identity.fixture.invalid/jwks",
    authorizationUrl: "https://identity.fixture.invalid/authorize",
    tokenUrl: "https://identity.fixture.invalid/token",
    ownerSubject: "fixture-human",
    ownerClientId: "fixture-owner",
    mcpClientId: "fixture-mcp",
    companionClientId: "fixture-companion",
    backend,
    deviceId: "fixture-device",
  };
  const keys = await generateKeyPair("ES256", { extractable: true });
  const jwks = {
    keys: [
      {
        ...(await exportJWK(keys.publicKey)),
        kid: "synthetic-test-key",
        alg: "ES256",
        use: "sig",
      },
    ],
  };
  let now = Date.now(),
    tokenRole: Authority = "owner",
    challenge = "";
  const token = async (
    role: Authority,
    overrides: JWTPayload = {},
    typ = "at+jwt",
  ) =>
    new SignJWT({
      client_id:
        config[
          role === "mcp"
            ? "mcpClientId"
            : role === "owner"
              ? "ownerClientId"
              : "companionClientId"
        ],
      scope: `fofix:${role}`,
      ...overrides,
    })
      .setProtectedHeader({ alg: "ES256", typ, kid: "synthetic-test-key" })
      .setIssuer(config.issuer)
      .setSubject(config.ownerSubject)
      .setAudience(
        `${config.origin}/${role === "companion" ? "session" : role}`,
      )
      .setIssuedAt(Math.floor(now / 1000))
      .setExpirationTime(Math.floor(now / 1000) + 600)
      .setJti(randomUUID())
      .sign(keys.privateKey);
  const signed = async (payload: JWTPayload, typ = "at+jwt") =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "ES256", typ, kid: "synthetic-test-key" })
      .sign(keys.privateKey);
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), config.tokenUrl);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("resource"), `${config.origin}/owner`);
    assert.equal(form.get("client_id"), config.ownerClientId);
    assert.equal(
      form.get("redirect_uri"),
      `${config.origin}/owner/auth/callback`,
    );
    assert.equal(
      createHash("sha256")
        .update(form.get("code_verifier")!)
        .digest("base64url"),
      challenge,
    );
    return Response.json({
      access_token: await token(tokenRole),
      token_type: "Bearer",
    });
  };
  return {
    config,
    jwks,
    key: createLocalJWKSet(jwks),
    token,
    signed,
    fetcher,
    clock: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setChallenge: (value: string) => {
      challenge = value;
    },
    setTokenRole: (role: Authority) => {
      tokenRole = role;
    },
  };
}

export async function remoteFixture(
  identity: Awaited<ReturnType<typeof identityFixture>>,
  service?: OwnerService,
  config: RemoteConfig = identity.config,
) {
  const store = new Store();
  const engine = new Engine(store, new FixtureAdapter(store));
  const actor = service ?? engine;
  const { app, errors } = createApp(actor, 4310, {
    config,
    auth: { key: identity.key, fetch: identity.fetcher, clock: identity.clock },
  });
  app.use(errors);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const request = (
    path: string,
    options: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {},
  ) =>
    new Promise<{
      status: number;
      headers: import("node:http").IncomingHttpHeaders;
      text: string;
      json: () => any;
    }>((resolve, reject) => {
      const headers = {
        Host: new URL(identity.config.origin).host,
        "X-Forwarded-Proto": "https",
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      };
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          path,
          method: options.method ?? "GET",
          headers,
          signal: options.signal,
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.once("end", () =>
            resolve({
              status: res.statusCode!,
              headers: res.headers,
              text,
              json: () => JSON.parse(text),
            }),
          );
        },
      );
      req.once("error", reject);
      req.end(
        options.body === undefined
          ? undefined
          : typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body),
      );
    });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, identity.config.origin);
    const response = await request(url.pathname + url.search, {
      method: init?.method,
      body: init?.body === undefined ? undefined : String(init.body),
      headers: Object.fromEntries(new Headers(init?.headers)),
      signal: init?.signal ?? undefined,
    });
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers))
      for (const item of Array.isArray(value) ? value : [value])
        if (item !== undefined) headers.append(key, item);
    return new Response(
      [204, 304].includes(response.status) ? null : response.text,
      { status: response.status, headers },
    );
  };
  const login = async () => {
    const started = await request("/owner/auth/login", {
      method: "POST",
      headers: { Origin: identity.config.origin },
      body: {},
    });
    assert.equal(started.status, 200);
    const authorization = new URL(started.json().authorizationUrl);
    assert.equal(authorization.origin, new URL(identity.config.issuer).origin);
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256",
    );
    identity.setChallenge(authorization.searchParams.get("code_challenge")!);
    const loginCookie = started.headers["set-cookie"]![0].split(";")[0];
    const callback = `/owner/auth/callback?state=${encodeURIComponent(authorization.searchParams.get("state")!)}&code=synthetic-code`;
    const finished = await request(callback, {
      headers: { Cookie: loginCookie },
    });
    assert.equal(finished.status, 303);
    const header = finished.headers["set-cookie"]!.find((c) =>
      c.startsWith("__Host-fofix_owner="),
    )!;
    assert.match(header, /HttpOnly/i);
    assert.match(header, /Secure/i);
    assert.match(header, /SameSite=Strict/i);
    assert.match(header, /Path=\//i);
    const cookie = header.split(";")[0];
    const session = await request("/api/auth", { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    const csrf = session.json().csrfToken as string;
    return { cookie, csrf, callback, loginCookie, authorization };
  };
  return {
    engine,
    store,
    request,
    fetcher,
    login,
    port: address.port,
    close: async () => {
      await actor.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

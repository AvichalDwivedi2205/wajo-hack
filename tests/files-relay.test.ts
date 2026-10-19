import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { FixtureAdapter } from "../src/companion/adapter.ts";
import type { OwnerService } from "../src/core/service.ts";
import { createApp } from "../src/server/app.ts";
import { SessionBroker } from "../src/server/session.ts";
import { runDeviceSession } from "../src/companion/bridge.ts";
import { AttachmentDownloads } from "../src/server/attachment-download.ts";
import { FILES_LIMITS } from "../src/files/contracts.ts";
import { identityFixture, remoteFixture } from "./support/remote.ts";
import { folderFixture, deck } from "./support/files.ts";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

test("folder tools relay MCP -> gateway -> bridge -> Mac; only the Mac grants access; deck downloads are single-use", { timeout: 120_000 }, async () => {
  const c = await folderFixture();
  const store = new Store(), audio = new Engine(store, new FixtureAdapter(store)), actor: OwnerService = audio;
  actor.files = c.engine;
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const { app, errors } = createApp(actor, port);
  app.use(errors);
  const server = app.listen(port, "127.0.0.1");
  await once(server, "listening");
  const local = async (method: string, path: string, headers: Record<string, string> = { Origin: origin }) => {
    const response = await fetch(`${origin}/api/${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, ...(method === "GET" ? {} : { body: "{}" }) });
    return { status: response.status, value: await response.json() };
  };
  const identity = await identityFixture("session");
  const broker = new SessionBroker(identity.config.deviceId!, Date.now, 25_000, false, false, true);
  const gateway = await remoteFixture(identity, broker);
  const controller = new AbortController();
  let connected!: () => void;
  const ready = new Promise<void>((resolve) => { connected = resolve; });
  const bridge = runDeviceSession({
    origin: identity.config.origin, accessToken: await identity.token("companion"), deviceId: identity.config.deviceId!,
    localPort: port, signal: controller.signal, fetcher: gateway.fetcher, onConnected: () => connected(),
  }).then(() => true, () => false);
  const client = new Client({ name: "synthetic-folder-relay", version: "1" });
  const download = (url: string) => new Promise<{ status: number; bytes: Buffer; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port: gateway.port, path: new URL(url).pathname, method: "GET",
      headers: { Host: new URL(identity.config.origin).host, "X-Forwarded-Proto": "https" } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (part) => parts.push(Buffer.from(part)));
      res.on("end", () => resolve({ status: res.statusCode!, bytes: Buffer.concat(parts), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
  try {
    await ready;
    await client.connect(new StreamableHTTPClientTransport(new URL(`${identity.config.origin}/mcp`), {
      fetch: gateway.fetcher, requestInit: { headers: { Authorization: `Bearer ${await identity.token("mcp")}` } },
    }));
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const name of ["files.list", "files.read", "files.search", "files.write", "files.undo_write", "files.share_download", "slides.create"])
      assert(names.includes(name), name);
    assert(!names.includes("files.read_artifact"), "gateway exposes downloads, not base64 chunks");
    assert(!names.some((n) => /grant|lease|allow|shell|command/.test(n)));
    assert(tools.every((t) => t.inputSchema.additionalProperties === false));
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    const result = (value: Awaited<ReturnType<typeof call>>) => {
      assert.notEqual(value.isError, true, JSON.stringify(value.content));
      return (value.structuredContent as { result: any }).result;
    };
    const denied = await call("files.list", { path: "" });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied.content), /FOLDER_LEASE_REQUIRED/);
    // The gateway owner session and machine credentials have no grant route.
    const owner = await gateway.login();
    assert.equal((await gateway.request("/api/folders/lease", { method: "POST", headers: { Cookie: owner.cookie, Origin: identity.config.origin, "X-FoFix-CSRF": owner.csrf }, body: {} })).status, 403);
    assert.equal((await gateway.request("/api/folders/lease", { method: "POST", headers: { Authorization: `Bearer ${await identity.token("mcp")}`, Origin: identity.config.origin }, body: {} })).status, 401);
    assert.equal((await gateway.request("/api/folders", { headers: { Cookie: owner.cookie } })).json().authority, "companion");
    // Locally, consent needs the exact loopback Origin.
    assert.equal((await local("POST", "folders/lease", {})).status, 403);
    assert.equal((await local("POST", "folders/lease", { Origin: "https://foreign.invalid" })).status, 403);
    const granted = await local("POST", "folders/lease");
    assert.equal(granted.status, 200);
    assert.equal(granted.value.lease.active, true);
    assert.deepEqual((await local("GET", "folders")).value.roots, [{ name: "vault", path: c.vault }]);

    const listed = result(await call("files.list", { path: "Notes", depth: 2 }));
    assert(listed.entries.some((e: any) => e.path === join(c.vault, "Notes", "plan.md")));
    // A write above the old 512 KiB relay job size (JSON escaping included).
    const content = 'say "hi"\n'.repeat(55_000);
    assert(Buffer.byteLength(JSON.stringify(content)) > 512 * 1024);
    const written = result(await call("files.write", { path: "Imports/big.md", content, mode: "create" }));
    assert.equal(written.sha256, sha(content));
    assert.equal(await readFile(join(c.vault, "Imports", "big.md"), "utf8"), content);
    const read = result(await call("files.read", { path: "Imports/big.md", maxBytes: 256 * 1024 }));
    assert.equal(read.truncated, true);
    assert(content.startsWith(read.text));
    assert.equal(result(await call("files.search", { query: "SHIP THE alpha" })).matches[0].line, 2);
    const appended = result(await call("files.write", { path: "Notes/plan.md", content: "- relay\n", mode: "append" }));
    assert(appended.backupPath);
    assert.equal(result(await call("files.undo_write", { writeId: appended.writeId })).action, "restored");
    assert.equal(await readFile(join(c.vault, "Notes", "plan.md"), "utf8"), "# Plan\nShip the Alpha launch\nalpha owner: Maya\n");
    assert.equal((await call("files.write", { path: "../escape.md", content: "x", mode: "create" })).isError, true);
    assert.equal((await call("files.read", { path: "link.md" })).isError, true);

    const slides = result(await call("slides.create", deck("Relay deck")));
    assert.equal(slides.pageCount, 3);
    const pdf = await readFile(slides.pdf.path);
    const share = result(await call("files.share_download", { path: slides.pdf.path }));
    assert.equal(share.sha256, slides.pdf.sha256);
    assert.equal(share.path, slides.pdf.path);
    assert(!JSON.stringify(share).includes("base64"));
    assert(Date.parse(share.expiresAt) - Date.now() <= 120_000);
    const received = await download(share.url);
    assert.equal(received.status, 200);
    assert.equal(sha(received.bytes), slides.pdf.sha256);
    assert.deepEqual(received.bytes, pdf);
    assert.equal(received.headers["content-type"], "application/pdf");
    assert.match(String(received.headers["content-disposition"]), /attachment; filename="Relay deck\.pdf"/);
    assert.equal((await download(share.url)).status, 403);
    // Not a deck created by slides.create in this lease: refused.
    assert.equal((await call("files.share_download", { path: "Notes/plan.md" })).isError, true);
    assert.equal((await call("files.share_download", { path: join(c.vault, "Imports", "big.pdf") })).isError, true);
    const expiring = result(await call("files.share_download", { path: slides.pptx.path }));
    identity.advance(120_001);
    assert.equal((await download(expiring.url)).status, 403);
    const revocable = result(await call("files.share_download", { path: slides.pptx.path }));
    assert.equal((await local("DELETE", "folders/lease")).status, 200);
    assert.notEqual((await download(revocable.url)).status, 200);
    const after = await call("files.list", { path: "" });
    assert.equal(after.isError, true);
    assert.match(JSON.stringify(after.content), /FOLDER_LEASE_REQUIRED/);
  } finally {
    controller.abort();
    await bridge;
    await client.close();
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await audio.shutdown();
    store.close();
    await c.close();
  }
});

test("deck download capabilities pin one file, check every chunk and the full hash, expire and cannot be replayed", async () => {
  let now = Date.now(), allowed = true, corrupt = false;
  const session = { sessionId: crypto.randomUUID(), expiresAt: now + 600_000 };
  const bytes = randomBytes(FILES_LIMITS.artifactChunk * 2 + 1234), hash = sha(bytes), path = "/synthetic/vault/Presentations/Deck.pptx";
  const offsets: number[] = [];
  const source = {
    attachmentSession: () => ({ ...session }),
    files: {
      readArtifact: async (args: { path: string; offset: number }) => {
        assert(allowed, "folder lease revoked");
        offsets.push(args.offset);
        const nextOffset = Math.min(args.offset + FILES_LIMITS.artifactChunk, bytes.length);
        const part = Buffer.from(bytes.subarray(args.offset, nextOffset));
        if (corrupt) part[0] ^= 1;
        return { path, name: "Deck.pptx", sha256: hash, totalBytes: bytes.length, offset: args.offset, nextOffset, base64: part.toString("base64") };
      },
    },
  };
  const links = new AttachmentDownloads(source, "https://gateway.fixture.invalid", () => now);
  const grant = await links.issueFile("Presentations/Deck.pptx");
  assert.equal(grant.path, path);
  const token = new URL(grant.url).pathname.split("/").at(-1)!;
  const file = await links.consume(token);
  assert.deepEqual(file.bytes, bytes);
  assert.equal(file.contentType, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.deepEqual(offsets, [0, 0, FILES_LIMITS.artifactChunk, FILES_LIMITS.artifactChunk * 2, 0]);
  await assert.rejects(links.consume(token), /unavailable|expired/);
  await assert.rejects(links.issueFile("Notes/plan.md"), /Only \.pptx and \.pdf/);
  await assert.rejects(links.issueFile("Presentations/Other.pdf"), /changed identity/);
  for (const failure of ["expire", "revoke", "corrupt", "session"] as const) {
    allowed = true; corrupt = false;
    const issued = await links.issueFile(path);
    const capability = new URL(issued.url).pathname.split("/").at(-1)!;
    if (failure === "expire") now += 120_001;
    if (failure === "revoke") allowed = false;
    if (failure === "corrupt") corrupt = true;
    if (failure === "session") session.sessionId = crypto.randomUUID();
    await assert.rejects(links.consume(capability));
    await assert.rejects(links.consume(capability), /unavailable|expired/);
    session.expiresAt = now + 600_000;
  }
});

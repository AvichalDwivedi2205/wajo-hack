import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { PhoneReview } from "../src/review/phone.ts";
import { agentRequest, relayJob } from "../src/shared/relay.ts";
import { Engine } from "../src/core/engine.ts";
import type { OwnerService } from "../src/core/service.ts";
import { FixtureAdapter } from "../src/companion/adapter.ts";
import { createApp } from "../src/server/app.ts";
import { SessionBroker } from "../src/server/session.ts";
import { runDeviceSession } from "../src/companion/bridge.ts";
import { identityFixture, remoteFixture } from "./support/remote.ts";
import { reviewFixture, prepared, finished } from "./support/review.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { request as httpRequest } from "node:http";

test("three-hour device sessions remain capped by the credential deadline and do not renew", async () => {
  let now = Date.now();
  const broker = new SessionBroker("synthetic-device", () => now);
  try {
    const started = now;
    const session = broker.connect("synthetic-device", "fixture");
    assert.equal(session.expiresAt, started + 3 * 60 * 60_000);
    now += 3 * 60 * 60_000 + 1;
    await assert.rejects(broker.inspect(), /absent or expired/);
    const deadline = now + 35 * 60_000;
    assert.equal(broker.connect("synthetic-device", "fixture", deadline).expiresAt, deadline);
  } finally { await broker.shutdown(); }
});

test("three-hour phone and folder access preserve short plan expiry and exact revocation", async () => {
  const c = await reviewFixture();
  let now = Date.now();
  const phone = new PhoneReview(c.engine, () => now);
  const link = { sessionId: randomUUID(), origin: "https://phone.fixture.invalid", deviceId: "synthetic-device", expiresAt: now + 3 * 60 * 60_000 };
  try {
    await c.engine.grant();
    phone.register(link); phone.enable(link);
    now += 2 * 60 * 60_000; c.advance(2 * 60 * 60_000);
    assert.equal(phone.state().enabled, true);
    const snapshot = await c.engine.snapshot(), plan = await c.engine.prepare(snapshot.id);
    await phone.invoke(link.sessionId, { op: "approve", id: plan.id, digest: plan.digest });
    now += 5 * 60_000 + 1; c.advance(5 * 60_000 + 1);
    await assert.rejects(c.engine.commit(plan.id), /expired/i);
    assert.equal(c.engine.status().jobs.length, 0);
    now += 55 * 60_000; c.advance(55 * 60_000);
    assert.equal(c.engine.permissionActive, false);
    assert.equal(phone.state().enabled, false);
    await assert.rejects(phone.invoke(link.sessionId, { op: "status" }), /unavailable/i);
    assert.throws(() => phone.register({ ...link, sessionId: randomUUID(), expiresAt: now + 3 * 60 * 60_000 + 5001 }), /bounded foreground session/);
  } finally { await c.close(); }
});

test("phone review requires an exact local opt-in and preserves digest, lease, and connection boundaries", async () => {
  const c = await reviewFixture();
  let now = Date.now();
  const phone = new PhoneReview(c.engine, () => now),
    link = { sessionId: randomUUID(), origin: "https://phone.fixture.invalid", deviceId: "synthetic-device", expiresAt: now + 60_000 };
  try {
    const { plan } = await prepared(c);
    phone.register(link);
    await assert.rejects(phone.invoke(link.sessionId, { op: "status" }), /Phone review is unavailable/);
    assert.throws(() => phone.enable({ ...link, deviceId: "other" }), /displayed phone session changed/);
    phone.enable(link);
    await assert.rejects(phone.invoke(randomUUID(), { op: "status" }), /Phone review is unavailable/);
    await assert.rejects(phone.invoke(link.sessionId, { op: "approve", id: plan.id, digest: "0".repeat(64) }), /does not match/);
    assert.equal(c.engine.status().plans[0].state, "pending");
    await phone.invoke(link.sessionId, { op: "approve", id: plan.id, digest: plan.digest });
    assert.equal(c.engine.status().plans[0].state, "approved");
    assert.equal(c.engine.status().jobs.length, 0);
    now += 60_001;
    await assert.rejects(c.engine.commit(plan.id), /Phone review is unavailable/);
    phone.register({ ...link, sessionId: randomUUID(), expiresAt: now + 60_000 });
    assert.equal(phone.state().enabled, false);
    await assert.rejects(phone.invoke(link.sessionId, { op: "status" }), /Phone review is unavailable/);
  } finally { await c.close(); }
});

test("revoking during queued phone approval and regranting folders cannot resurrect authority", async () => {
  const c = await reviewFixture(), phone = new PhoneReview(c.engine),
    link = { sessionId: randomUUID(), origin: "https://phone.fixture.invalid", deviceId: "synthetic-device", expiresAt: Date.now() + 60_000 };
  try {
    const { plan } = await prepared(c);
    phone.register(link); phone.enable(link);
    const approval = phone.invoke(link.sessionId, { op: "approve", id: plan.id, digest: plan.digest });
    phone.disable();
    await assert.rejects(approval, /Phone review is unavailable/);
    assert.equal(c.engine.status().plans[0].state, "denied");
    await c.engine.grant();
    assert.equal(phone.state().enabled, false);
    await assert.rejects(phone.invoke(link.sessionId, { op: "status" }), /Phone review is unavailable/);
    assert.equal(agentRequest.safeParse({ tool: "review.approve", args: { id: plan.id, digest: plan.digest } }).success, false);
    assert.equal(relayJob.safeParse({ id: randomUUID(), request: { tool: "review.snapshot", args: {} }, ownerRequest: { op: "status" } }).success, false);
    for (const op of ["grant", "commit", "shell", "fetch"]) assert.equal(relayJob.safeParse({ id: randomUUID(), ownerRequest: { op } }).success, false);
  } finally { await c.close(); }
});

test("phone gateway rejects approval evidence for another plan, digest or state", async () => {
  const c = await reviewFixture(), broker = new SessionBroker("synthetic-device", Date.now, 5000, true),
    session = broker.connect("synthetic-device", "fixture");
  try {
    const { plan } = await prepared(c), approved = await c.engine.approve(plan.id, plan.digest);
    for (const altered of [{ ...approved, id: randomUUID() }, { ...approved, digest: "0".repeat(64) }, { ...approved, state: "pending" }]) {
      const operation = broker.phoneReview({ op: "approve", id: plan.id, digest: plan.digest });
      const job = await broker.poll(session.sessionId, new AbortController().signal);
      assert(job && "ownerRequest" in job);
      broker.complete(session.sessionId, job.id, { structuredContent: { result: altered } });
      await assert.rejects(operation, /does not match the requested plan/);
    }
  } finally { await broker.shutdown(); await c.close(); }
});

test("completed UI polling cannot consume the pending-work quota during phone review", async () => {
  const broker = new SessionBroker("synthetic-device", Date.now, 5000), session = broker.connect("synthetic-device", "fixture");
  try {
    for (let index = 0; index < 160; index++) {
      const operation = broker.inspect(), job = await broker.poll(session.sessionId, new AbortController().signal);
      assert(job);
      broker.complete(session.sessionId, job.id, { structuredContent: { result: { synthetic: true } } });
      await operation;
    }
    const pending = Array.from({ length: 64 }, () => broker.inspect());
    const observed = Promise.allSettled(pending);
    await assert.rejects(broker.inspect(), /bounded device queue is full/);
    broker.disconnect();
    assert((await observed).every(result => result.status === "rejected"));
  } finally { await broker.shutdown(); }
});

test("attachment sharing needs separate exact approval and reconstructs unchanged PDF bytes, then expires with phone session", async () => {
  const c = await reviewFixture();
  let now = Date.now();
  const phone = new PhoneReview(c.engine, () => now), link = {
    sessionId: randomUUID(), origin: "https://phone.fixture.invalid", deviceId: "synthetic-device", expiresAt: now + 60_000,
  };
  try {
    const { plan } = await prepared(c);
    await c.engine.approve(plan.id, plan.digest);
    const job = await c.engine.commit(plan.id);
    assert.equal((await finished(c, job.id)).state, "succeeded");
    await assert.rejects(c.engine.readAttachment(job.id, "review.pdf", 0), /explicitly allow Fo/);
    phone.register(link); phone.enable(link);
    const share = c.engine.status().attachmentShares!.find(item => item.id === job.id)!;
    await assert.rejects(phone.invoke(link.sessionId, { op: "share", id: job.id, digest: "0".repeat(64) }), /approve these exact/);
    await phone.invoke(link.sessionId, { op: "share", id: job.id, digest: share.digest });
    const chunks: Buffer[] = [];
    let offset = 0, expectedHash = "", total = 0;
    do {
      const chunk = await c.engine.readAttachment(job.id, "review.pdf", offset);
      chunks.push(Buffer.from(chunk.base64, "base64"));
      offset = chunk.nextOffset; total = chunk.totalBytes; expectedHash = chunk.sha256;
    } while (offset < total);
    const bytes = Buffer.concat(chunks);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash);
    assert.deepEqual(bytes, await c.engine.artifact(job.id, "review.pdf"));
    now += 60_001;
    assert.equal(c.engine.status().attachmentShares![0].approved, false);
    await assert.rejects(c.engine.readAttachment(job.id, "review.pdf", 0), /Phone review is unavailable/);
  } finally { await c.close(); }
});

test("attachment sharing expires after five minutes and refuses changed generated bytes", async () => {
  const c = await reviewFixture();
  try {
    const { plan } = await prepared(c);
    await c.engine.approve(plan.id, plan.digest);
    const job = await c.engine.commit(plan.id);
    await finished(c, job.id);
    const digest = c.engine.status().attachmentShares![0].digest;
    await c.engine.approveAttachments(job.id, digest);
    c.advance(5 * 60_000 + 1);
    await assert.rejects(c.engine.readAttachment(job.id, "review.pdf", 0), /explicitly allow Fo/);
    await c.engine.approveAttachments(job.id, digest);
    await assert.rejects(c.engine.readAttachment(job.id, "review.pdf", 1), /64 KiB chunk offsets/);
    await appendFile(join(plan.destination, "review.pdf"), "synthetic tamper");
    await assert.rejects(c.engine.readAttachment(job.id, "review.pdf", 0));
    c.engine.revoke(); await c.engine.grant();
    await assert.rejects(c.engine.readAttachment(job.id, "review.pdf", 0), /explicitly allow Fo/);
  } finally { await c.close(); }
});

test("owner phone approval traverses real HTTP gateway and foreground bridge; MCP cannot approve; Fo still must commit (synthetic SDK test)", { timeout: 30_000 }, async () => {
  const c = await reviewFixture(), audio = new Engine(c.store, new FixtureAdapter(c.store));
  const actor: OwnerService = audio;
  actor.review = c.engine;
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as AddressInfo).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`, { app, errors } = createApp(actor, port);
  app.use(errors);
  const server = app.listen(port, "127.0.0.1");
  await once(server, "listening");
  const local = async (path: string, body?: unknown) => {
    const response = await fetch(`${origin}/api/review${path}`, body === undefined ? {} : {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  const identity = await identityFixture("session"), broker = new SessionBroker(identity.config.deviceId!, Date.now, 5000, true),
    gateway = await remoteFixture(identity, broker), controller = new AbortController();
  let connected!: () => void;
  const connection = new Promise<void>(resolve => { connected = resolve; });
  const bridge = runDeviceSession({
    origin: identity.config.origin, accessToken: await identity.token("companion"), deviceId: identity.config.deviceId!,
    localPort: port, signal: controller.signal, fetcher: gateway.fetcher, requestPhoneReview: true, onConnected: connected,
  }).catch(() => {});
  const client = new Client({ name: "synthetic-phone-review-test", version: "1" });
  try {
    await connection;
    const owner = await gateway.login(), headers = { Cookie: owner.cookie, Origin: identity.config.origin, "X-FoFix-CSRF": owner.csrf };
    const remote = (path: string, body?: unknown, custom = headers) => gateway.request(`/api/review${path}`, {
      ...(body === undefined ? {} : { method: "POST", body }), headers: custom,
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${identity.config.origin}/mcp`), {
      fetch: gateway.fetcher, requestInit: { headers: { Authorization: `Bearer ${await identity.token("mcp")}` } },
    }));
    const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
    const result = (r: any) => { assert.notEqual(r.isError, true); return r.structuredContent.result; };
    assert(!(await client.listTools()).tools.some(t => /approve|phone/.test(t.name) && t.name !== "fo_fix_execute_approved"));
    assert.equal((await remote("/permission", {})).status, 403);
    assert.equal((await remote("/phone/enable", {})).status, 403);
    await local("/permission", {});
    const snapshot = result(await call("review.snapshot")), plan = result(await call("review.prepare", { snapshotId: snapshot.id }));
    assert.equal((await remote(`/plans/${plan.id}/approve`, { digest: plan.digest })).status, 403);
    const state = (await local("")).value;
    assert.equal(state.phoneReview.enabled, false);
    assert.equal((await local("/phone/enable", state.phoneReview.link)).status, 200);
    const phoneStatus = await remote("");
    assert.equal(phoneStatus.json().authority, "phone");
    assert.equal(phoneStatus.json().plans[0].id, plan.id);
    assert.equal((await remote(`/images/before?digest=${plan.snapshot.digest}`)).status, 200);
    assert.equal((await remote(`/plans/${plan.id}/approve`, { digest: "0".repeat(64) })).status, 409);
    const mcpHeader = { Authorization: `Bearer ${await identity.token("mcp")}`, Origin: identity.config.origin };
    assert.equal((await remote(`/plans/${plan.id}/approve`, { digest: plan.digest }, mcpHeader as any)).status, 401);
    assert.equal((await remote(`/plans/${plan.id}/approve`, { digest: plan.digest }, { ...headers, "X-FoFix-CSRF": "wrong" })).status, 403);
    assert.equal((await remote(`/plans/${plan.id}/approve`, { digest: plan.digest }, { ...headers, Origin: "https://foreign.invalid" })).status, 403);
    assert.equal((await call("review.approve", { id: plan.id, digest: plan.digest })).isError, true);
    assert.equal((await call("review.commit", { id: plan.id })).isError, true);
    const approved = await remote(`/plans/${plan.id}/approve`, { digest: plan.digest });
    assert.equal(approved.status, 200);
    assert.equal(approved.json().state, "approved");
    assert.equal((await remote(`/plans/${plan.id}/approve`, { digest: plan.digest })).status, 409);
    assert.equal(c.engine.status().jobs.length, 0);
    const job = result(await call("review.commit", { id: plan.id }));
    const complete = await finished(c, job.id);
    assert.equal(complete.state, "succeeded");
    const pdf = await remote(`/jobs/${job.id}/artifacts/review.pdf`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.text, /^%PDF/);
    assert.equal((await call("review.read_attachment", { id: job.id, name: "review.pdf", offset: 0 })).isError, true);
    const share = (await remote("")).json().attachmentShares.find((item: any) => item.id === job.id);
    assert.equal((await remote(`/jobs/${job.id}/attachment-approval`, { digest: share.digest })).status, 200);
    const chunk = result(await call("review.read_attachment", { id: job.id, name: "review.pdf", offset: 0 }));
    assert.equal(chunk.sha256, complete.artifacts.find(file => file.name === "review.pdf")!.sha256);
    assert.match(Buffer.from(chunk.base64, "base64").toString("ascii"), /^%PDF/);
    // The real MCP -> gateway -> companion path issues metadata only. A coding
    // sandbox can fetch exact bytes without copying base64 through model text.
    const grant = result(await call("review.attachment_download", { id: job.id, name: "review.pdf" }));
    assert(grant.url && !JSON.stringify(grant).includes("base64"));
    const download = (url: string, method = "GET") => new Promise<{ status: number; bytes: Buffer; cache?: string }>((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port: gateway.port, path: new URL(url).pathname, method,
        headers: { Host: new URL(identity.config.origin).host, "X-Forwarded-Proto": "https" } }, res => {
        const parts: Buffer[] = []; res.on("data", part => parts.push(Buffer.from(part)));
        res.on("end", () => resolve({ status: res.statusCode!, bytes: Buffer.concat(parts), cache: res.headers["cache-control"] }));
      }); req.on("error", reject); req.end();
    });
    assert.equal((await download(grant.url, "HEAD")).status, 405);
    const received = await download(grant.url);
    assert.equal(received.status, 200); assert.equal(received.cache, "no-store");
    assert.equal(createHash("sha256").update(received.bytes).digest("hex"), grant.sha256);
    assert.equal((await download(grant.url)).status, 403);
    const revokedGrant = result(await call("review.attachment_download", { id: job.id, name: "review.pdf" }));
    assert.equal((await remote(`/jobs/${job.id}/artifacts/manifest.json`)).status, 400);
    assert.equal((await local("/phone/disable", {})).status, 200);
    const deniedDownload = await download(revokedGrant.url);
    assert.equal(deniedDownload.status, 409); // Existing MCP relay refusal status.
    assert.match(deniedDownload.bytes.toString(), /REVIEW_PERMISSION|ATTACHMENT_APPROVAL_REQUIRED/);
    assert.equal((await call("review.attachment_download", { id: job.id, name: "review.pdf" })).isError, true);
    assert.equal((await remote(`/jobs/${job.id}/artifacts/review.pdf`)).status, 403);
    assert.equal((await call("review.read_attachment", { id: job.id, name: "review.pdf", offset: 0 })).isError, true);
  } finally {
    controller.abort(); await bridge; await client.close(); await gateway.close();
    await new Promise<void>(resolve => server.close(() => resolve())); await c.close();
  }
});

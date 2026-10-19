import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AttachmentDownloads } from "../src/server/attachment-download.ts";

function fixture() {
  let now = Date.now(), allowed = true;
  let session = { sessionId: randomUUID(), expiresAt: now + 60_000 };
  const id = randomUUID(), name = "review.pptx" as const;
  const bytes = randomBytes(104632), hash = createHash("sha256").update(bytes).digest("hex");
  const offsets: number[] = [];
  let changeHash = false, corruptPayload = false;
  const source = {
    attachmentSession: () => ({ ...session }),
    review: { readAttachment: async (actualId: string, actualName: string, offset: number) => {
      assert.equal(actualId, id); assert.equal(actualName, name);
      assert(allowed, "attachment sharing revoked"); offsets.push(offset);
      const nextOffset = Math.min(offset + 65536, bytes.length);
      const part = Buffer.from(bytes.subarray(offset, nextOffset));
      if (corruptPayload) part[0] ^= 1;
      return { id, name, offset, nextOffset, totalBytes: bytes.length, sha256: changeHash ? "0".repeat(64) : hash,
        base64: part.toString("base64") };
    } },
  };
  const links = new AttachmentDownloads(source, "https://gateway.fixture.invalid", () => now);
  return { id, name, bytes, hash, links, offsets,
    revoke: () => { allowed = false; },
    advance: (ms: number) => { now += ms; },
    reconnect: () => { session = { ...session, sessionId: randomUUID() }; },
    corrupt: () => { changeHash = true; },
    corruptPayload: () => { corruptPayload = true; },
  };
}

test("approved attachment download avoids MCP binary text, preserves full hash and is single-use", async () => {
  const c = fixture(), grant = await c.links.issue(c.id, c.name);
  assert(Buffer.byteLength(JSON.stringify(grant)) < 1024);
  assert.equal(grant.sha256, c.hash);
  const token = new URL(grant.url).pathname.split("/").at(-1)!;
  const downloaded = await c.links.consume(token);
  assert.deepEqual(downloaded.bytes, c.bytes);
  assert.equal(downloaded.name, c.name);
  assert.deepEqual(c.offsets, [0, 0, 65536, 0]);
  await assert.rejects(c.links.consume(token), /unavailable|expired/);
});

test("download rejects missing sharing, expiry, reconnected session, revoked access and changed bytes", async () => {
  const initial = fixture(); initial.revoke();
  await assert.rejects(initial.links.issue(initial.id, initial.name), /revoked/);
  for (const failure of ["advance", "reconnect", "revoke", "corrupt", "corruptPayload"] as const) {
    const c = fixture(), grant = await c.links.issue(c.id, c.name);
    const token = new URL(grant.url).pathname.split("/").at(-1)!;
    if (failure === "advance") c.advance(60_001); else c[failure]();
    await assert.rejects(c.links.consume(token));
  }
});

test("download never grants arbitrary files or retains more than 32 live capabilities", async () => {
  const c = fixture();
  await assert.rejects(c.links.issue(c.id, "../private" as any));
  for (let i = 0; i < 32; i++) await c.links.issue(c.id, c.name);
  await assert.rejects(c.links.issue(c.id, c.name), /limit/);
  await assert.rejects(c.links.consume("unknown"));
});

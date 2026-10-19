import { createHash, randomBytes } from "node:crypto";
import { invariant } from "../core/errors.ts";
import { attachmentChunk, reviewId } from "../review/contracts.ts";
import type { ReviewAgent } from "../review/contracts.ts";
import { z } from "zod";

export const attachmentDownloadRequest = reviewId.extend({ name: z.enum(["review.pdf", "review.pptx"]) }).strict();
type Source = {
  review?: Pick<ReviewAgent, "readAttachment">;
  attachmentSession(): { sessionId: string; expiresAt: number };
};
type Grant = { id: string; name: "review.pdf" | "review.pptx"; sessionId: string; until: number; sha256: string; totalBytes: number };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

// No attachment cache, stored credentials, or new file authority. Each HTTP
// download re-reads through the existing Mac sharing gate, then checks full SHA.
// Capabilities are random, single-use, memory-only and never logged here.
export class AttachmentDownloads {
  private grants = new Map<string, Grant>();
  private active = 0;
  constructor(private source: Source, private origin: string, private clock = Date.now) {}
  private current(grant: Pick<Grant, "sessionId" | "until">) {
    const session = this.source.attachmentSession();
    invariant(session.sessionId === grant.sessionId && session.expiresAt > this.clock() && grant.until > this.clock(),
      "DOWNLOAD_EXPIRED", "The single-use attachment download is unavailable or expired.", 403);
  }
  private async read(grant: Pick<Grant, "id" | "name"> & Partial<Grant>, offset: number) {
    invariant(this.source.review, "REVIEW_DISABLED", "Client review is not configured.", 404);
    const chunk = attachmentChunk.parse(await this.source.review.readAttachment(grant.id, grant.name, offset));
    const bytes = Buffer.from(chunk.base64, "base64");
    invariant(chunk.id === grant.id && chunk.name === grant.name && chunk.offset === offset &&
      chunk.nextOffset === Math.min(offset + 65536, chunk.totalBytes) && bytes.length === chunk.nextOffset - offset &&
      bytes.toString("base64") === chunk.base64 && (!grant.sha256 || grant.sha256 === chunk.sha256) &&
      (!grant.totalBytes || grant.totalBytes === chunk.totalBytes),
      "ATTACHMENT_CHANGED", "The approved attachment bytes or metadata changed.", 409);
    return { chunk, bytes };
  }
  async issue(id: string, name: "review.pdf" | "review.pptx") {
    attachmentDownloadRequest.parse({ id, name });
    for (const [key, grant] of this.grants) if (grant.until <= this.clock()) this.grants.delete(key);
    invariant(this.grants.size < 32, "DOWNLOAD_LIMIT", "The live attachment download limit is reached.", 429);
    const session = this.source.attachmentSession();
    const { chunk } = await this.read({ id, name }, 0);
    const grant: Grant = { id, name, sessionId: session.sessionId, until: Math.min(this.clock() + 120_000, session.expiresAt),
      sha256: chunk.sha256, totalBytes: chunk.totalBytes };
    this.current(grant);
    // Recheck after the asynchronous read; parallel issues cannot exceed quota.
    invariant(this.grants.size < 32, "DOWNLOAD_LIMIT", "The live attachment download limit is reached.", 429);
    const token = randomBytes(32).toString("base64url");
    this.grants.set(digest(token), grant);
    return { id, name, sha256: grant.sha256, totalBytes: grant.totalBytes, expiresAt: new Date(grant.until).toISOString(),
      url: `${this.origin}/attachments/${token}` };
  }
  async consume(token: string) {
    invariant(/^[A-Za-z0-9_-]{43}$/.test(token), "DOWNLOAD_EXPIRED", "The attachment download is unavailable or expired.", 403);
    const key = digest(token), grant = this.grants.get(key);
    invariant(grant, "DOWNLOAD_EXPIRED", "The attachment download is unavailable or expired.", 403);
    invariant(this.active < 2, "DOWNLOAD_LIMIT", "The active attachment download limit is reached.", 429);
    this.grants.delete(key); // Even a failed fetch cannot replay this capability.
    this.active++;
    try {
      this.current(grant);
      const parts: Buffer[] = [];
      for (let offset = 0; offset < grant.totalBytes;) {
        const { chunk, bytes } = await this.read(grant, offset);
        this.current(grant); parts.push(bytes); offset = chunk.nextOffset;
      }
      // Revocation or file mutation during assembly must prevent any HTTP bytes.
      await this.read(grant, 0); this.current(grant);
      const bytes = Buffer.concat(parts);
      invariant(bytes.length === grant.totalBytes && digest(bytes) === grant.sha256,
        "ATTACHMENT_CHANGED", "The complete attachment hash does not match the approved bytes.", 409);
      return { name: grant.name, bytes };
    } finally { this.active--; }
  }
}

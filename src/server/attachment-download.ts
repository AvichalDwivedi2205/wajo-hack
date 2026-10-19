import { createHash, randomBytes } from "node:crypto";
import { basename } from "node:path";
import { invariant } from "../core/errors.ts";
import { attachmentChunk, reviewId } from "../review/contracts.ts";
import type { ReviewAgent } from "../review/contracts.ts";
import { artifactChunk, filesShare, FILES_LIMITS, type FilesAgent } from "../files/contracts.ts";
import { z } from "zod";

export const attachmentDownloadRequest = reviewId.extend({ name: z.enum(["review.pdf", "review.pptx"]) }).strict();
export const fileDownloadRequest = filesShare;
type Source = {
  review?: Pick<ReviewAgent, "readAttachment">;
  files?: Pick<FilesAgent, "readArtifact">;
  attachmentSession(): { sessionId: string; expiresAt: number };
};
type Chunk = { sha256: string; totalBytes: number; offset: number; nextOffset: number; base64: string };
type Expected = { sha256: string; totalBytes: number };
type Read = { chunk: Chunk; bytes: Buffer; name: string; path?: string };
type Reader = (offset: number, expected?: Expected) => Promise<Read>;
type Grant = { name: string; reader: Reader; sessionId: string; until: number; sha256: string; totalBytes: number };
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const downloadType = (name: string) =>
  /\.pdf$/i.test(name) ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// No attachment cache, stored credentials, or new file authority. Each HTTP
// download re-reads through the existing Mac gate (review sharing approval, or
// the folder lease for decks made by slides.create), then checks the full SHA.
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
  private checked(chunk: Chunk, offset: number, size: number, expected?: Expected) {
    const bytes = Buffer.from(chunk.base64, "base64");
    invariant(chunk.offset === offset && chunk.nextOffset === Math.min(offset + size, chunk.totalBytes) && chunk.nextOffset > offset &&
      bytes.length === chunk.nextOffset - offset && bytes.toString("base64") === chunk.base64 &&
      (!expected || (expected.sha256 === chunk.sha256 && expected.totalBytes === chunk.totalBytes)),
      "ATTACHMENT_CHANGED", "The approved attachment bytes or metadata changed.", 409);
    return bytes;
  }
  private async grant(reader: Reader) {
    for (const [key, grant] of this.grants) if (grant.until <= this.clock()) this.grants.delete(key);
    invariant(this.grants.size < 32, "DOWNLOAD_LIMIT", "The live attachment download limit is reached.", 429);
    const session = this.source.attachmentSession();
    const first = await reader(0);
    const grant: Grant = { name: first.name, reader, sessionId: session.sessionId, until: Math.min(this.clock() + 120_000, session.expiresAt),
      sha256: first.chunk.sha256, totalBytes: first.chunk.totalBytes };
    this.current(grant);
    // Recheck after the asynchronous read; parallel issues cannot exceed quota.
    invariant(this.grants.size < 32, "DOWNLOAD_LIMIT", "The live attachment download limit is reached.", 429);
    const token = randomBytes(32).toString("base64url");
    this.grants.set(digest(token), grant);
    return { first, issued: { sha256: grant.sha256, totalBytes: grant.totalBytes, expiresAt: new Date(grant.until).toISOString(), url: `${this.origin}/attachments/${token}` } };
  }
  async issue(id: string, name: "review.pdf" | "review.pptx") {
    attachmentDownloadRequest.parse({ id, name });
    invariant(this.source.review, "REVIEW_DISABLED", "Client review is not configured.", 404);
    const review = this.source.review;
    const { issued } = await this.grant(async (offset, expected) => {
      const chunk = attachmentChunk.parse(await review.readAttachment(id, name, offset));
      invariant(chunk.id === id && chunk.name === name, "ATTACHMENT_CHANGED", "The approved attachment bytes or metadata changed.", 409);
      return { chunk, name, bytes: this.checked(chunk, offset, 65536, expected) };
    });
    return { id, name, ...issued };
  }
  /** A .pptx/.pdf deck created by slides.create during the current Mac folder lease. */
  async issueFile(path: string) {
    fileDownloadRequest.parse({ path });
    invariant(/\.(pptx|pdf)$/i.test(path), "FILES_SHARE_UNAVAILABLE", "Only .pptx and .pdf decks created by slides.create can be shared.", 400);
    invariant(this.source.files, "FILES_DISABLED", "Folder tools are not configured.", 404);
    const files = this.source.files;
    let pinned: string | undefined;
    const { first, issued } = await this.grant(async (offset, expected) => {
      const chunk = artifactChunk.parse(await files.readArtifact({ path: pinned ?? path, offset }));
      invariant(chunk.totalBytes <= FILES_LIMITS.shareBytes && /\.(pptx|pdf)$/i.test(chunk.path) && chunk.name === basename(chunk.path) &&
        basename(chunk.path) === basename(path) && (!pinned || chunk.path === pinned),
        "ATTACHMENT_CHANGED", "The shared file changed identity.", 409);
      pinned ??= chunk.path;
      return { chunk, name: chunk.name, path: chunk.path, bytes: this.checked(chunk, offset, FILES_LIMITS.artifactChunk, expected) };
    });
    return { path: first.path!, name: first.name, ...issued };
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
      const expected = { sha256: grant.sha256, totalBytes: grant.totalBytes };
      const parts: Buffer[] = [];
      for (let offset = 0; offset < grant.totalBytes;) {
        const { chunk, bytes } = await grant.reader(offset, expected);
        this.current(grant); parts.push(bytes); offset = chunk.nextOffset;
      }
      // Revocation or file mutation during assembly must prevent any HTTP bytes.
      await grant.reader(0, expected); this.current(grant);
      const bytes = Buffer.concat(parts);
      invariant(bytes.length === grant.totalBytes && digest(bytes) === grant.sha256,
        "ATTACHMENT_CHANGED", "The complete attachment hash does not match the approved bytes.", 409);
      return { name: grant.name, contentType: downloadType(grant.name), bytes };
    } finally { this.active--; }
  }
}

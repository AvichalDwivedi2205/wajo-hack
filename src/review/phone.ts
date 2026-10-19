import { z } from "zod";
import { DEVICE_SESSION_MS } from "../shared/limits.ts";
import { invariant } from "../core/errors.ts";
import type { ReviewEngine } from "./engine.ts";
import { reviewApproval, reviewPlanSchema, reviewJobSchema, attachmentShare } from "./contracts.ts";

export const artifactName = z.enum(["review.pdf", "review.pptx", "page-1.png", "page-2.png", "page-3.png"]);
export const phoneLink = z.object({
  sessionId: z.uuid(),
  origin: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash;
  }),
  deviceId: z.string().min(1).max(128),
  expiresAt: z.number().int().positive(),
}).strict();
export type PhoneLink = z.infer<typeof phoneLink>;
export const phoneRequest = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status") }).strict(),
  z.object({ op: z.literal("revoke") }).strict(),
  z.object({ op: z.literal("approve"), id: z.uuid(), digest: reviewApproval.shape.digest }).strict(),
  z.object({ op: z.literal("deny"), id: z.uuid() }).strict(),
  z.object({ op: z.literal("visual"), id: z.uuid() }).strict(),
  z.object({ op: z.literal("share"), id: z.uuid(), digest: reviewApproval.shape.digest }).strict(),
  z.object({ op: z.literal("image"), role: z.enum(["before", "proposed"]), digest: reviewApproval.shape.digest }).strict(),
  z.object({ op: z.literal("artifact"), id: z.uuid(), name: artifactName }).strict(),
]);
export type PhoneRequest = z.infer<typeof phoneRequest>;
// Owner previews alone may transfer bounded bytes; agent results stay metadata-only.
export const phoneBytes = z.object({ base64: z.string().max(349528).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict();
export type PhoneReviewState = { enabled: boolean; link?: PhoneLink };
export const phoneStatus = z.object({
  enabled: z.literal(true), authority: z.literal("phone"), synthetic: z.boolean(),
  outputKind: z.enum(["simulation", "keynote", "pptx"]).optional(),
  folders: z.array(z.string().max(2048)).length(3), destination: z.string().max(2048),
  permission: z.object({ active: z.boolean(), expiresAt: z.iso.datetime().optional() }).strict(),
  plans: z.array(reviewPlanSchema).max(8), jobs: z.array(reviewJobSchema).max(8),
  attachmentShares: z.array(attachmentShare).max(8).optional(),
  blockers: z.array(z.string().max(1024)).max(8),
  phoneReview: z.object({ enabled: z.boolean(), link: phoneLink.optional() }).strict(),
}).strict();

/** A local human opt-in for one existing lease and one foreground connection. */
export class PhoneReview {
  private link?: PhoneLink;
  private epoch?: number;
  constructor(private review: ReviewEngine, private clock = Date.now) {}
  register(value: PhoneLink) {
    const link = phoneLink.parse(value);
    invariant(link.expiresAt > this.clock() && link.expiresAt <= this.clock() + DEVICE_SESSION_MS + 5000,
      "PHONE_SESSION_INVALID", "Phone review needs a current bounded foreground session.", 403);
    invariant(!this.link || this.link.expiresAt <= this.clock(), "PHONE_SESSION_ACTIVE", "End the existing phone review session on the Mac first.", 409);
    this.link = link;
    this.epoch = undefined;
    return this.state();
  }
  private active() {
    return !!this.link && this.link.expiresAt > this.clock() &&
      this.epoch !== undefined && this.epoch === this.review.permissionEpoch && this.review.permissionActive;
  }
  state(): PhoneReviewState {
    return { enabled: this.active(), ...(this.link ? { link: structuredClone(this.link) } : {}) };
  }
  enable(value: PhoneLink) {
    const link = phoneLink.parse(value);
    invariant(this.link && JSON.stringify(link) === JSON.stringify(this.link) && this.link.expiresAt > this.clock(),
      "PHONE_SESSION_CHANGED", "The displayed phone session changed. Review the current gateway, device and expiry again.", 403);
    invariant(this.review.permissionActive, "REVIEW_PERMISSION_REQUIRED", "Allow the three review folders locally before enabling phone review.", 403);
    this.epoch = this.review.permissionEpoch;
    return this.state();
  }
  disable() {
    this.epoch = undefined;
    // Revoke pending and already approved plans; stopping phone review must not
    // leave an approval available to a later Fo commit.
    this.review.revoke();
    return this.state();
  }
  end(sessionId: string) {
    if (this.link?.sessionId === sessionId) {
      if (this.epoch !== undefined) this.disable();
      this.link = undefined;
    }
  }
  async invoke(sessionId: string, value: PhoneRequest) {
    const request = phoneRequest.parse(value), link = this.link, epoch = this.epoch;
    const guard = () => invariant(this.active() && this.link === link && epoch === this.epoch && link?.sessionId === sessionId,
      "LOCAL_REVIEW_REQUIRED", "Phone review is unavailable. On the Mac, allow the folders and explicitly enable this foreground phone session.", 403);
    guard();
    let result: unknown;
    switch (request.op) {
      case "status": result = { ...this.review.status(), authority: "phone", phoneReview: this.state() }; break;
      case "revoke": this.disable(); return { ...this.review.status(), authority: "phone", phoneReview: this.state() };
      case "approve": result = await this.review.approve(request.id, request.digest, guard); break;
      case "deny": result = this.review.deny(request.id); break;
      case "visual": result = await this.review.visualApprove(request.id, guard); break;
      case "share": result = await this.review.approveAttachments(request.id, request.digest, guard); break;
      case "image":
      case "artifact": {
        const bytes = request.op === "image" ? await this.review.image(request.role, request.digest) : await this.review.artifact(request.id, request.name);
        invariant(bytes.length <= 256 * 1024, "PHONE_PREVIEW_TOO_LARGE", "This phone preview exceeds 256 KiB. Review it on the Mac; no partial preview is returned.", 413);
        result = { base64: bytes.toString("base64") };
        break;
      }
    }
    guard();
    return result;
  }
}

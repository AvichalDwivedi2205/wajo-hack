import { z } from "zod";

export type ReviewOutputKind = "simulation" | "keynote" | "pptx";
const outputKind = z.enum(["simulation", "keynote", "pptx"]);

export const reviewId = z.object({ id: z.uuid() }).strict();
export const reviewPrepare = z.object({ snapshotId: z.uuid() }).strict();
export const reviewApproval = z
  .object({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const reviewEmpty = z.object({}).strict();
export const reviewAttachment = z.object({
  id: z.uuid(), name: z.enum(["review.pdf", "review.pptx"]),
  offset: z.number().int().min(0).max(3 * 1024 * 1024).multipleOf(65536),
}).strict();
export const attachmentShare = z.object({
  id: z.uuid(), digest: reviewApproval.shape.digest, approved: z.boolean(), expiresAt: z.iso.datetime().optional(),
}).strict();
export const attachmentChunk = z.object({
  id: z.uuid(), name: z.enum(["review.pdf", "review.pptx"]), sha256: reviewApproval.shape.digest,
  totalBytes: z.number().int().positive().max(3 * 1024 * 1024),
  offset: z.number().int().min(0).multipleOf(65536), nextOffset: z.number().int().positive(),
  base64: z.string().min(1).max(87384).regex(/^[A-Za-z0-9+/]+={0,2}$/),
}).strict();
export type ReviewMetric = {
  visitors: number;
  paid: number;
  refunded: number;
  retained: number;
  basisPoints: number;
  gateBasisPoints: number;
  oldBasisPoints: number;
  onePaymentPerVisitor: true;
  decision: "hold";
  trace: string[];
};
export type ReviewSlide = {
  title: string;
  kicker: string;
  body: string[];
  footer: string;
};
export type ReviewSnapshot = {
  id: string;
  digest: string;
  capturedAt: string;
  synthetic: boolean;
  outputKind?: ReviewOutputKind;
  dataClassification: "synthetic-demo";
  cohort: string;
  cutoff: string;
  ruleId: string;
  metric: ReviewMetric;
  sources: {
    id: string;
    path: string;
    sha256: string;
    revision: string;
    selected: boolean;
  }[];
};
export type ReviewPlan = {
  id: string;
  digest: string;
  snapshot: ReviewSnapshot;
  slides: ReviewSlide[];
  destination: string;
  expiresAt: string;
  state: "pending" | "approved" | "denied" | "consumed";
  recipe: "keynote-fixed-slots-v1" | "pptx-fixed-slots-v1";
  direction: "create" | "undo";
  jobId?: string;
  recipeSha256: string;
};
export type ReviewJob = {
  id: string;
  planId: string;
  state: "queued" | "running" | "succeeded" | "failed" | "uncertain" | "undone";
  synthetic: boolean;
  outputKind?: ReviewOutputKind;
  startedAt: string;
  completedAt?: string;
  message: string;
  artifacts: { name: string; sha256: string; bytes: number }[];
  nativeEvidence?: {
    coldStart: boolean;
    keynoteVersion: string;
    dictionarySha256: string;
    recipeSha256: string;
    copyLeftOpen: true;
  };
  pptxEvidence?: z.infer<typeof pptxEvidenceSchema>;
  verification?: {
    pages: number;
    textChecked: boolean;
    originalsUnchanged: boolean;
    renderedPages: number;
    visualApproved: boolean;
  };
};
export type ReviewStatus = {
  enabled: true;
  authority: "here" | "companion" | "phone";
  phoneReview?: import("./phone.ts").PhoneReviewState;
  attachmentShares?: z.infer<typeof attachmentShare>[];
  synthetic: boolean;
  outputKind?: ReviewOutputKind;
  folders: string[];
  destination: string;
  permission: { active: boolean; expiresAt?: string };
  plans: ReviewPlan[];
  jobs: ReviewJob[];
  blockers: string[];
};
export interface ReviewAgent {
  readAttachment(id: string, name: "review.pdf" | "review.pptx", offset: number): Promise<z.infer<typeof attachmentChunk>>;
  snapshot(): Promise<ReviewSnapshot>;
  prepare(snapshotId: string): Promise<ReviewPlan>;
  commit(id: string): Promise<ReviewJob>;
  verify(id: string): Promise<ReviewJob>;
  undo(id: string): Promise<ReviewPlan>;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const nativeIdentitySchema = z
  .object({
    recipeSha256: digest,
    dictionarySha256: digest,
    keynoteVersion: z.string().min(1).max(60),
  })
  .strict();
export const reviewSnapshotSchema = z
  .object({
    id: z.uuid(),
    digest,
    capturedAt: z.iso.datetime(),
    synthetic: z.boolean(),
    outputKind: outputKind.optional(),
    dataClassification: z.literal("synthetic-demo"),
    cohort: z.string().max(64),
    cutoff: z.iso.datetime(),
    ruleId: z.literal("retained-v1"),
    metric: z
      .object({
        visitors: z.literal(12000),
        paid: z.literal(660),
        refunded: z.literal(120),
        retained: z.literal(540),
        basisPoints: z.literal(450),
        gateBasisPoints: z.literal(500),
        oldBasisPoints: z.literal(550),
        onePaymentPerVisitor: z.literal(true),
        decision: z.literal("hold"),
        trace: z.array(z.string().max(256)).length(4),
      })
      .strict(),
    sources: z
      .array(
        z
          .object({
            id: z.string().max(60),
            path: z.string().max(160),
            sha256: digest,
            revision: z.string().max(40),
            selected: z.boolean(),
          })
          .strict(),
      )
      .length(10),
  })
  .strict()
  .refine(s => !s.outputKind || s.synthetic === (s.outputKind === "simulation"), { message: "Output kind must agree with simulation status." });
export const reviewPlanSchema = z
  .object({
    id: z.uuid(),
    digest,
    snapshot: reviewSnapshotSchema,
    slides: z
      .array(
        z
          .object({
            title: z.string().max(200),
            kicker: z.string().max(80),
            body: z.array(z.string().max(300)).max(6),
            footer: z.string().max(256),
          })
          .strict(),
      )
      .length(3),
    destination: z.string().max(1024),
    expiresAt: z.iso.datetime(),
    state: z.enum(["pending", "approved", "denied", "consumed"]),
    recipe: z.enum(["keynote-fixed-slots-v1", "pptx-fixed-slots-v1"]),
    recipeSha256: digest,
    direction: z.enum(["create", "undo"]),
    jobId: z.uuid().optional(),
  })
  .strict()
  .refine(p => (p.recipe === "pptx-fixed-slots-v1") === (p.snapshot.outputKind === "pptx"), { message: "The selected output kind and approved recipe must match." });
export const nativeEvidenceSchema = z
  .object({
    coldStart: z.boolean(),
    keynoteVersion: z.string().min(1).max(60),
    dictionarySha256: digest,
    recipeSha256: digest,
    copyLeftOpen: z.literal(true),
  })
  .strict();
export const pptxEvidenceSchema = z.object({
  renderer: z.literal("macos-quick-look+chrome"),
  chromeVersion: z.string().min(1).max(80),
  recipeSha256: digest,
  pptxSha256: digest,
  pdfSha256: digest,
}).strict();
export const reviewJobSchema = z
  .object({
    id: z.uuid(),
    planId: z.uuid(),
    state: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "uncertain",
      "undone",
    ]),
    synthetic: z.boolean(),
    outputKind: outputKind.optional(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    message: z.string().max(512),
    artifacts: z
      .array(
        z
          .object({
            name: z.enum([
              "review.pdf",
              "review.html",
              "review.json",
              "review.key",
              "review.pptx",
              "page-1.png",
              "page-2.png",
              "page-3.png",
              "template.key",
              "before.png",
              "proposed.png",
              "request.json",
              "receipt.json",
            ]),
            sha256: digest,
            bytes: z
              .number()
              .int()
              .min(0)
              .max(32 * 1024 * 1024),
          })
          .strict(),
      )
      .max(10),
    nativeEvidence: nativeEvidenceSchema.optional(),
    pptxEvidence: pptxEvidenceSchema.optional(),
    verification: z
      .object({
        pages: z.literal(3),
        textChecked: z.boolean(),
        originalsUnchanged: z.boolean(),
        renderedPages: z.literal(3),
        visualApproved: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(j => !j.outputKind || j.synthetic === (j.outputKind === "simulation"), { message: "Output kind must agree with simulation status." })
  .refine((j) => j.state !== "succeeded" || (j.outputKind === "pptx"
    ? !j.synthetic && !j.nativeEvidence && !!j.pptxEvidence
    : j.synthetic || !!j.nativeEvidence), {
    message: "Verified native results require the fixed native recipe receipt.",
  });

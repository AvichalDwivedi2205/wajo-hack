import { z } from "zod";
import { repairRequest } from "./requests.ts";
import { reviewId, reviewPrepare, reviewAttachment } from "../review/contracts.ts";
import { appOpenRequest, appPlanId } from "../apps/contracts.ts";
import { phoneRequest } from "../review/phone.ts";
import { filesList, filesRead, filesSearch, filesWrite, filesUndo, artifactRead, slidesCreate } from "../files/contracts.ts";

const empty = z.object({}).strict();
export const agentRequest = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("apps.inspect"), args: empty }).strict(),
  z
    .object({ tool: z.literal("apps.propose_open"), args: appOpenRequest })
    .strict(),
  z.object({ tool: z.literal("apps.open_approved"), args: appPlanId }).strict(),
  z.object({ tool: z.literal("fo_fix_status"), args: empty }).strict(),
  z.object({ tool: z.literal("fo_fix_inspect_output"), args: empty }).strict(),
  z
    .object({ tool: z.literal("fo_fix_propose_repair"), args: repairRequest })
    .strict(),
  z
    .object({
      tool: z.literal("fo_fix_execute_approved"),
      args: z.object({ planId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      tool: z.literal("fo_fix_propose_undo"),
      args: z.object({ actionId: z.uuid() }).strict(),
    })
    .strict(),
  z.object({ tool: z.literal("review.snapshot"), args: empty }).strict(),
  z.object({ tool: z.literal("review.prepare"), args: reviewPrepare }).strict(),
  z.object({ tool: z.literal("review.commit"), args: reviewId }).strict(),
  z.object({ tool: z.literal("review.verify"), args: reviewId }).strict(),
  z.object({ tool: z.literal("review.read_attachment"), args: reviewAttachment }).strict(),
  z.object({ tool: z.literal("review.undo"), args: reviewId }).strict(),
  // Folder tools: owner-chosen roots and a local lease on the Mac. No grant.
  z.object({ tool: z.literal("files.list"), args: filesList }).strict(),
  z.object({ tool: z.literal("files.read"), args: filesRead }).strict(),
  z.object({ tool: z.literal("files.search"), args: filesSearch }).strict(),
  z.object({ tool: z.literal("files.write"), args: filesWrite }).strict(),
  z.object({ tool: z.literal("files.undo_write"), args: filesUndo }).strict(),
  z.object({ tool: z.literal("files.read_artifact"), args: artifactRead }).strict(),
  z.object({ tool: z.literal("slides.create"), args: slidesCreate }).strict(),
]);
export type AgentRequest = z.infer<typeof agentRequest>;
// The owner queue is never exposed through an MCP tool or machine credential.
export const relayJob = z.union([
  z.object({ id: z.uuid(), request: agentRequest }).strict(),
  z.object({ id: z.uuid(), ownerRequest: phoneRequest }).strict(),
]);
export type RelayJob = z.infer<typeof relayJob>;
export const relayConnection = z
  .object({ sessionId: z.uuid(), expiresAt: z.number().int().positive() })
  .strict();
export const relayPoll = z.object({ job: relayJob.nullable() }).strict();

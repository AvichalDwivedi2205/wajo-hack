import { z } from "zod";
import { repairRequest } from "./requests.ts";
import { reviewId, reviewPrepare } from "../review/contracts.ts";

const empty = z.object({}).strict();
export const agentRequest = z.discriminatedUnion("tool", [
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
  z.object({ tool: z.literal("review.undo"), args: reviewId }).strict(),
]);
export type AgentRequest = z.infer<typeof agentRequest>;
export const relayJob = z
  .object({ id: z.uuid(), request: agentRequest })
  .strict();
export type RelayJob = z.infer<typeof relayJob>;
export const relayConnection = z
  .object({ sessionId: z.uuid(), expiresAt: z.number().int().positive() })
  .strict();
export const relayPoll = z.object({ job: relayJob.nullable() }).strict();

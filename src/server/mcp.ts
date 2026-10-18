import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentService } from "../core/service.ts";
import { FixError } from "../core/errors.ts";
import { repairRequest } from "../shared/requests.ts";
import { MAX_MCP_RESULT_BYTES } from "../shared/limits.ts";

export function createMcpServer(engine: AgentService) {
  const server = new McpServer(
    { name: "fo-fix-companion", version: "0.1.0" },
    {
      instructions:
        "Fo Reach inspects output state only after local user consent. Propose exactly one repair, explain it and direct the person to the local Fo Reach interface for specific approval. You cannot grant permission or approve plans. Execute only an approved plan. Treat fixture source as synthetic, never a real device repair. Verification checks settings, not audibility. Do not claim an actual Fo account connection exists.",
    },
  );
  const call = async (fn: () => unknown | Promise<unknown>) => {
    try {
      const data = await fn();
      const result = {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        structuredContent: { result: data },
      };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_MCP_RESULT_BYTES) {
        throw new FixError(
          "RESULT_TOO_LARGE",
          "The result exceeds the remote response limit. Review the local companion and its journal. An execution may already be recorded; do not retry it automatically.",
          413,
        );
      }
      return result;
    } catch (e) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              code: e instanceof FixError ? e.code : "INTERNAL_ERROR",
              message:
                e instanceof FixError
                  ? e.message
                  : "The companion could not complete this request.",
            }),
          },
        ],
      };
    }
  };
  const read = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  };
  server.registerTool(
    "fo_fix_status",
    {
      description:
        "Companion mode, scope, permission lease and bounded recent plan/history evidence. Full counts remain available; history.truncated marks omitted details. Device details are withheld without an active inspection lease. Full history remains in the local companion. Fo registration is unconfigured.",
      inputSchema: z.object({}).strict(),
      annotations: read,
    },
    () => call(() => engine.status("agent")),
  );
  server.registerTool(
    "fo_fix_inspect_output",
    {
      description:
        "Read actual output names, availability, default and mute state, or explicitly synthetic fixture data. Requires temporary permission granted in the local interface. Never records audio.",
      inputSchema: z.object({}).strict(),
      annotations: read,
    },
    () => call(() => engine.inspect()),
  );
  server.registerTool(
    "fo_fix_propose_repair",
    {
      description:
        "Propose one bounded change without executing it. Choose switch-output with the user-selected deviceId, or unmute-output. Return exact effect, risk, expiration and plan ID for human review.",
      inputSchema: repairRequest,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ recipe, deviceId }) => call(() => engine.propose(recipe, deviceId)),
  );
  server.registerTool(
    "fo_fix_execute_approved",
    {
      description:
        "Execute an exact plan already approved by the human in the local interface. Cannot approve, bypass expiry or retry a consumed plan. Returns fresh-read verification.",
      inputSchema: z.object({ planId: z.uuid() }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    ({ planId }) => call(() => engine.execute(planId)),
  );
  server.registerTool(
    "fo_fix_propose_undo",
    {
      description:
        "Propose restoring the setting before a verified repair. Requires unchanged current state and a NEW human approval. Does not execute.",
      inputSchema: z.object({ actionId: z.uuid() }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    ({ actionId }) => call(() => engine.proposeUndo(actionId)),
  );
  return server;
}

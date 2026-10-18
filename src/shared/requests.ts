import { z } from "zod";

// Keep HTTP and MCP argument validation identical. Unmute always targets the
// currently selected output; silently ignoring an explicit target is unsafe.
export const repairRequest = z
  .object({
    recipe: z.enum(["switch-output", "unmute-output"]),
    deviceId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.recipe === "switch-output" && !request.deviceId) {
      context.addIssue({
        code: "custom",
        path: ["deviceId"],
        message: "Switch-output requires a user-selected deviceId.",
      });
    }
    if (request.recipe === "unmute-output" && request.deviceId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["deviceId"],
        message: "Unmute-output targets the active output; omit deviceId.",
      });
    }
  });

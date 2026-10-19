// Leave space for relay/session IDs inside the 512 KiB HTTP result-body limit.
export const MAX_MCP_RESULT_BYTES = 480 * 1024;
export const MAX_AGENT_STATUS_BYTES = 96 * 1024;
// One manually started device connection and its review-folder lease. No renewal.
export const DEVICE_SESSION_MS = 3 * 60 * 60_000;

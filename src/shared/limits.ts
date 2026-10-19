// Leave space for relay/session IDs inside the 512 KiB HTTP result-body limit.
export const MAX_MCP_RESULT_BYTES = 480 * 1024;
export const MAX_AGENT_STATUS_BYTES = 96 * 1024;
// MCP requests may carry one bounded folder write (512 KiB UTF-8, at most
// 768 KiB JSON-escaped). The relayed job is limited the same way.
export const MAX_MCP_REQUEST_BYTES = 1024 * 1024;
export const MAX_RELAY_JOB_BYTES = 1024 * 1024;
// One manually started device connection and its review-folder lease. No renewal.
export const DEVICE_SESSION_MS = 3 * 60 * 60_000;

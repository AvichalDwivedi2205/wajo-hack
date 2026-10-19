import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { relayConnection, relayPoll } from "../shared/relay.ts";
import { FixError, invariant } from "../core/errors.ts";
import type { Mode } from "../shared/types.ts";
import { boundedJson } from "../shared/bounded-json.ts";
import { DEVICE_SESSION_MS } from "../shared/limits.ts";
import { setTimeout as delay } from "node:timers/promises";

export async function runDeviceSession(options: {
  origin: string;
  accessToken: string;
  deviceId: string;
  localPort: number;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  clock?: () => number;
  onConnected?: (source: Mode, expiresAt: number, sessionId: string) => void;
  onPollRetry?: (attempt: number) => void;
  requestPhoneReview?: boolean;
  // Manual foreground restart using the original, locally retained gateway
  // receipt. This never calls connect, renews a lease, or restores local grants.
  resumeConnection?: { sessionId: string; expiresAt: number };
}) {
  const origin = new URL(options.origin);
  invariant(
    origin.protocol === "https:" &&
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash,
    "INVALID_GATEWAY",
    "Use the approved gateway HTTPS origin.",
    400,
  );
  invariant(
    !!options.accessToken &&
      options.accessToken.length <= 16384 &&
      !/[\s]/.test(options.accessToken),
    "SESSION_TOKEN_REQUIRED",
    "Provide a previously authorized companion access token through the environment.",
    400,
  );
  invariant(
    Number.isInteger(options.localPort) &&
      options.localPort >= 1024 &&
      options.localPort <= 65535,
    "INVALID_LOCAL_PORT",
    "Use a valid loopback companion port.",
    400,
  );
  const fetcher = options.fetcher ?? fetch,
    clock = options.clock ?? Date.now;
  const post = async (path: string, data: unknown) => {
    const response = await fetcher(new URL(path, origin), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
      redirect: "error",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
    });
    if (path === "/session/poll" && response.status === 409) {
      const value = await boundedJson(response, 16 * 1024).catch(() => undefined) as { code?: unknown } | undefined;
      if (value?.code === "POLL_IN_PROGRESS") throw new FixError("POLL_IN_PROGRESS", "The previous read-only poll is still closing.", 409);
    }
    invariant(
      response.ok,
      "DEVICE_SESSION_REJECTED",
      "The gateway rejected the device session. No automatic reconnection was attempted.",
      response.status,
    );
    return boundedJson(response, 512 * 1024);
  };
  const client = new Client({
    name: "fo-fix-device-session",
    version: "0.1.0",
  });
  let sessionId: string | undefined;
  const localOrigin = `http://127.0.0.1:${options.localPort}`;
  const ownerPost = async (path: string, data: unknown) => {
    const response = await fetch(new URL(`/api/review/phone/${path}`, localOrigin), {
      method: "POST", headers: { "Content-Type": "application/json", Origin: localOrigin },
      body: JSON.stringify(data), redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    const result = await boundedJson(response, 480 * 1024);
    if (!response.ok) {
      const error = result as { code?: unknown; message?: unknown };
      throw new FixError(typeof error.code === "string" && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : "PHONE_REVIEW_REJECTED",
        typeof error.message === "string" && error.message.length <= 512 ? error.message : "The local phone-review gate rejected this request. Review the Mac interface.", response.status);
    }
    return result;
  };
  try {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${options.localPort}/mcp`),
      ),
    );
    const initial = await client.callTool({
      name: "fo_fix_status",
      arguments: {},
    });
    const source = (initial.structuredContent as { result?: { mode?: Mode } })
      ?.result?.mode;
    invariant(
      source === "fixture" || source === "macos",
      "LOCAL_COMPANION_UNAVAILABLE",
      "Start the local companion before connecting a device session.",
      503,
    );
    const connected = relayConnection.parse(
      options.resumeConnection ?? await post("/session/connect", { deviceId: options.deviceId, source }),
    );
    sessionId = connected.sessionId;
    invariant(
      connected.expiresAt > clock() &&
        connected.expiresAt <= clock() + DEVICE_SESSION_MS + 5000,
      "INVALID_GATEWAY_RESPONSE",
      "The gateway returned an invalid bounded session.",
      502,
    );
    const poll = async () => {
      for (let attempt = 0; ; attempt++) {
        if (options.signal.aborted || clock() >= connected.expiresAt) return { job: null };
        try { return relayPoll.parse(await post("/session/poll", { sessionId: connected.sessionId })); }
        catch (error) {
          const transient = error instanceof TypeError ||
            (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) ||
            (error instanceof FixError && error.code === "POLL_IN_PROGRESS");
          if (!transient || options.signal.aborted || clock() >= connected.expiresAt || attempt >= 4) throw error;
          options.onPollRetry?.(attempt + 1);
          await delay(Math.min(1000 * 2 ** attempt, 4000, connected.expiresAt - clock()), undefined, { signal: options.signal });
        }
      }
    };
    // Confirm the existing session with its companion-authenticated poll before
    // advertising a resumed connection or registering its local owner envelope.
    let firstPoll: Awaited<ReturnType<typeof poll>> | undefined;
    if (options.resumeConnection) {
      firstPoll = await poll();
      invariant(!options.signal.aborted && clock() < connected.expiresAt,
        "DEVICE_SESSION_UNAVAILABLE", "The original device session ended before it could resume.", 503);
    }
    if (options.requestPhoneReview) await ownerPost("link", {
      ...connected, origin: origin.origin, deviceId: options.deviceId,
    });
    options.onConnected?.(source, connected.expiresAt, connected.sessionId);
    while (!options.signal.aborted && clock() < connected.expiresAt) {
      const { job } = firstPoll ?? await poll();
      firstPoll = undefined;
      // A long poll can finish after the deadline or after local cancellation.
      // Never start another local tool call once that end is observable here.
      if (options.signal.aborted || clock() >= connected.expiresAt) break;
      if (!job) continue;
      // Machine calls stay in MCP. Owner review uses a distinct, locally opted-in
      // path with no grant, execute, shell, arbitrary file or URL operation.
      let result;
      if ("ownerRequest" in job) {
        try {
          invariant(options.requestPhoneReview, "LOCAL_REVIEW_REQUIRED", "Phone review was not requested by this foreground launcher.", 403);
          const value = await ownerPost("relay", { sessionId, request: job.ownerRequest });
          result = { structuredContent: { result: value } };
        } catch (error) {
          result = { isError: true, content: [{ type: "text", text: JSON.stringify(error instanceof FixError ? { code: error.code, message: error.message, status: error.status } : { code: "PHONE_REVIEW_UNCERTAIN", message: "Phone review did not return a result. Check its current state before another action.", status: 503 }) }] };
        }
      } else result = await client.callTool({ name: job.request.tool, arguments: job.request.args });
      await post("/session/result", {
        sessionId: connected.sessionId,
        jobId: job.id,
        result,
      });
    }
  } finally {
    if (options.requestPhoneReview && sessionId) await ownerPost("end", { sessionId }).catch(() => {});
    await client.close();
  }
}

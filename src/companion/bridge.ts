import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { relayConnection, relayPoll } from "../shared/relay.ts";
import { FixError, invariant } from "../core/errors.ts";
import type { Mode } from "../shared/types.ts";
import { boundedJson } from "../shared/bounded-json.ts";

export async function runDeviceSession(options: {
  origin: string;
  accessToken: string;
  deviceId: string;
  localPort: number;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  clock?: () => number;
  onConnected?: (source: Mode, expiresAt: number) => void;
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
      await post("/session/connect", { deviceId: options.deviceId, source }),
    );
    invariant(
      connected.expiresAt > clock() &&
        connected.expiresAt <= clock() + 20 * 60_000 + 5000,
      "INVALID_GATEWAY_RESPONSE",
      "The gateway returned an invalid bounded session.",
      502,
    );
    options.onConnected?.(source, connected.expiresAt);
    while (!options.signal.aborted && clock() < connected.expiresAt) {
      const { job } = relayPoll.parse(
        await post("/session/poll", { sessionId: connected.sessionId }),
      );
      // A long poll can finish after the deadline or after local cancellation.
      // Never start another local tool call once that end is observable here.
      if (options.signal.aborted || clock() >= connected.expiresAt) break;
      if (!job) continue;
      // The shared schema admits no URLs, owner commands, shells or arbitrary tools.
      const result = await client.callTool({
        name: job.request.tool,
        arguments: job.request.args,
      });
      await post("/session/result", {
        sessionId: connected.sessionId,
        jobId: job.id,
        result,
      });
    }
  } finally {
    await client.close();
  }
}

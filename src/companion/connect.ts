import { runDeviceSession } from "./bridge.ts";
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());
try {
  await runDeviceSession({
    origin: process.env.FO_FIX_GATEWAY_ORIGIN ?? "",
    accessToken: process.env.FO_FIX_COMPANION_ACCESS_TOKEN ?? "",
    deviceId: process.env.FO_FIX_DEVICE_ID ?? "",
    localPort: Number(process.env.FO_FIX_PORT ?? "4310"),
    signal: controller.signal,
    requestPhoneReview: process.argv.includes("--phone-review"),
    onConnected: (source, expiresAt) =>
      console.error(
        `Device session connected: ${source === "fixture" ? "SYNTHETIC FIXTURE" : "local macOS companion"}; expires ${new Date(expiresAt).toISOString()}. ${process.argv.includes("--phone-review") ? "On the Mac, allow review folders and explicitly enable this exact phone session. Phone review cannot grant or renew file access." : "Allow inspection and approve individual changes in the local interface."}`,
      ),
  });
} catch {
  console.error(
    "Device session ended or could not connect. Check approved configuration and the local journal. No write was retried and no automatic reconnection was attempted.",
  );
  if (!controller.signal.aborted) process.exitCode = 1;
}

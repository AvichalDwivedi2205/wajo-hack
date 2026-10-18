import {
  configurationDiagnostics,
  networkDiagnostics,
} from "../src/server/diagnostics.ts";
const configuration = configurationDiagnostics();
console.log(
  JSON.stringify(
    {
      ...configuration,
      ...(process.argv.includes("--network")
        ? { network: { checked: true, probes: await networkDiagnostics() } }
        : {}),
    },
    null,
    2,
  ),
);
if (!configuration.configurationReady) process.exitCode = 2;

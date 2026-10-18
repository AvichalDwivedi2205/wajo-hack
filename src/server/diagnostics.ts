import { checkConfig } from "./config.ts";

export function configurationDiagnostics(env: NodeJS.ProcessEnv = process.env) {
  const result = checkConfig(env);
  return {
    configurationReady: !!result.config,
    issues: result.issues,
    anthropic: {
      credentialPresent: !!env.ANTHROPIC_API_KEY,
      requiredVariable: "ANTHROPIC_API_KEY",
      customEndpointPresent: !!env.ANTHROPIC_BASE_URL,
      tokenAlternativePresent: !!env.ANTHROPIC_AUTH_TOKEN,
      paidRequestMade: false,
    },
    proxy: {
      httpPresent: !!env.HTTP_PROXY || !!env.http_proxy,
      httpsPresent: !!env.HTTPS_PROXY || !!env.https_proxy,
      bypassListPresent: !!env.NO_PROXY || !!env.no_proxy,
      nodeOptInPresent:
        !!env.NODE_USE_ENV_PROXY ||
        process.execArgv.includes("--use-env-proxy"),
    },
    network: {
      checked: false,
      message:
        "No network or paid model call runs automatically. Use npm run diagnostics:network for fixed, unauthenticated connectivity probes.",
    },
  };
}

export async function networkDiagnostics(fetcher: typeof fetch = fetch) {
  const probes = [
    { name: "anthropic", url: "https://api.anthropic.com/v1/models" },
    { name: "wajo", url: "https://mcp.wajo.ai/mcp" },
  ];
  return Promise.all(
    probes.map(async (probe) => {
      try {
        const response = await fetcher(probe.url, {
          method: "HEAD",
          redirect: "error",
          signal: AbortSignal.timeout(8000),
          headers: { "anthropic-version": "2023-06-01" },
        });
        await response.body?.cancel();
        return {
          service: probe.name,
          status: response.status === 403 ? "denied" : "reachable",
          httpStatus: response.status,
          authenticated: false,
          paidRequestMade: false,
        };
      } catch (error) {
        let denied = false,
          cause: unknown = error;
        for (
          let depth = 0;
          depth < 5 && cause && typeof cause === "object";
          depth++
        ) {
          const level = cause as {
            statusCode?: unknown;
            message?: unknown;
            cause?: unknown;
          };
          if (
            level.statusCode === 403 ||
            (typeof level.message === "string" &&
              /proxy.*\b403\b/is.test(level.message))
          )
            denied = true;
          cause = level.cause;
        }
        return {
          service: probe.name,
          status: denied ? "denied_by_proxy" : "network_unavailable",
          authenticated: false,
          paidRequestMade: false,
        };
      }
    }),
  );
}

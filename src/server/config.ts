import { isIP } from "node:net";
import { FixError } from "../core/errors.ts";

export type LocalConfig = { mode: "local"; port: number };
type RemoteBase = {
  mode: "remote";
  port: number;
  origin: string;
  backend: "fixture" | "session";
  deviceId?: string;
  listenHost: "127.0.0.1" | "0.0.0.0";
  trustedProxyAddresses: string[];
};
export type OAuthRemoteConfig = RemoteBase & {
  authMode: "oauth";
  issuer: string;
  jwksUrl: string;
  authorizationUrl: string;
  tokenUrl: string;
  ownerSubject: string;
  ownerClientId: string;
  mcpClientId: string;
  companionClientId?: string;
};
export type BearerRemoteConfig = RemoteBase & {
  authMode: "bearer";
  mcpTokenHash: string;
  ownerTokenHash: string;
  companionTokenHash?: string;
  accessExpiresAt: number;
};
export type RemoteConfig = OAuthRemoteConfig | BearerRemoteConfig;
export type ServerConfig = LocalConfig | RemoteConfig;
export type ConfigurationIssue = { field: string; message: string };

export function checkConfig(env: NodeJS.ProcessEnv): {
  config?: ServerConfig;
  issues: ConfigurationIssue[];
} {
  const issues: ConfigurationIssue[] = [];
  const issue = (field: string, message: string) =>
    issues.push({ field, message });
  const port = Number(env.FO_FIX_PORT ?? env.PORT ?? "4310");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    issue("FO_FIX_PORT", "Use a port from 1024 to 65535.");
  const mode = env.FO_FIX_MODE ?? "local";
  if (mode === "local") {
    if (env.FO_FIX_PUBLIC_ORIGIN)
      issue(
        "FO_FIX_MODE",
        "Public-origin configuration requires explicit remote mode.",
      );
    return issues.length ? { issues } : { config: { mode, port }, issues };
  }
  if (mode !== "remote") {
    issue("FO_FIX_MODE", "Use local or remote.");
    return { issues };
  }
  const required = (field: string) => {
    const value = env[field]?.trim();
    if (
      !value ||
      value.length > 1024 ||
      /[\r\n\s]/.test(value) ||
      /^(CHANGE|REPLACE|YOUR_|<)/i.test(value)
    )
      issue(
        field,
        "Provide this configuration through the approved deployment environment.",
      );
    return value ?? "";
  };
  const httpsUrl = (field: string, originOnly = false) => {
    const value = required(field);
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        url.search ||
        (originOnly && url.pathname !== "/")
      )
        throw new Error();
      return originOnly ? url.origin : value;
    } catch {
      issue(
        field,
        "Use a credential-free HTTPS URL without a query or fragment.",
      );
      return "";
    }
  };
  const origin = httpsUrl("FO_FIX_PUBLIC_ORIGIN", true);
  const backend = env.FO_FIX_BACKEND;
  if (backend !== "fixture" && backend !== "session")
    issue(
      "FO_FIX_BACKEND",
      "Explicitly select fixture or session; remote mode cannot read native hardware directly.",
    );
  const deviceId =
    backend === "session" ? required("FO_FIX_DEVICE_ID") : undefined;
  if (deviceId && deviceId.length > 128)
    issue(
      "FO_FIX_DEVICE_ID",
      "Use a device identifier of at most 128 characters.",
    );
  const listenHost = env.FO_FIX_LISTEN_HOST ?? "127.0.0.1";
  if (listenHost !== "127.0.0.1" && listenHost !== "0.0.0.0")
    issue(
      "FO_FIX_LISTEN_HOST",
      "Use 127.0.0.1 or explicitly select 0.0.0.0 behind the approved proxy.",
    );
  let trustedProxyAddresses: string[] = [];
  if (env.FO_FIX_TRUST_PROXY === "loopback") {
    trustedProxyAddresses = ["127.0.0.1", "::1"];
    if (listenHost !== "127.0.0.1")
      issue(
        "FO_FIX_LISTEN_HOST",
        "The loopback proxy profile requires a loopback listener.",
      );
    if (env.FO_FIX_PROXY_ADDRESSES)
      issue(
        "FO_FIX_PROXY_ADDRESSES",
        "Select the addresses proxy profile to supply an explicit allowlist.",
      );
  } else if (env.FO_FIX_TRUST_PROXY === "addresses") {
    trustedProxyAddresses = required("FO_FIX_PROXY_ADDRESSES")
      .split(",")
      .map((s) => s.trim());
    if (
      trustedProxyAddresses.length > 16 ||
      trustedProxyAddresses.some(
        (ip) => !isIP(ip) || ip === "0.0.0.0" || ip === "::",
      )
    )
      issue(
        "FO_FIX_PROXY_ADDRESSES",
        "Provide at most 16 exact trusted proxy IP addresses; no names, wildcards, ranges or unspecified addresses.",
      );
  } else
    issue(
      "FO_FIX_TRUST_PROXY",
      "Explicitly select loopback or an exact addresses allowlist.",
    );
  const base = {
    mode: "remote" as const,
    port,
    origin,
    backend: backend as "fixture" | "session",
    deviceId,
    listenHost: listenHost as "127.0.0.1" | "0.0.0.0",
    trustedProxyAddresses,
  };
  if (env.FO_FIX_AUTH_MODE === "bearer") {
    const digest = (field: string) => {
      const value = required(field);
      if (!/^[a-f0-9]{64}$/.test(value))
        issue(
          field,
          "Provide a SHA-256 hex digest of an independently authorized high-entropy credential.",
        );
      return value;
    };
    const mcpTokenHash = digest("FO_FIX_MCP_TOKEN_SHA256");
    const ownerTokenHash = digest("FO_FIX_OWNER_TOKEN_SHA256");
    const companionTokenHash =
      backend === "session"
        ? digest("FO_FIX_COMPANION_TOKEN_SHA256")
        : undefined;
    const digests = [mcpTokenHash, ownerTokenHash, companionTokenHash].filter(
      Boolean,
    );
    if (new Set(digests).size !== digests.length)
      issue(
        "FO_FIX_OWNER_TOKEN_SHA256",
        "MCP, owner and companion credentials must be distinct.",
      );
    const expiry = required("FO_FIX_ACCESS_EXPIRES_AT");
    const accessExpiresAt = Date.parse(expiry);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiry) ||
      !Number.isFinite(accessExpiresAt) ||
      accessExpiresAt <= Date.now() ||
      accessExpiresAt > Date.now() + 24 * 60 * 60_000
    )
      issue(
        "FO_FIX_ACCESS_EXPIRES_AT",
        "Provide a UTC ISO expiry in the next 24 hours; access fails closed at that time.",
      );
    if (issues.length) return { issues };
    return {
      config: {
        ...base,
        authMode: "bearer",
        mcpTokenHash,
        ownerTokenHash,
        companionTokenHash,
        accessExpiresAt,
      },
      issues,
    };
  }
  if (env.FO_FIX_AUTH_MODE !== "oauth") {
    issue(
      "FO_FIX_AUTH_MODE",
      "Explicitly select bearer for the single-owner profile, or oauth for an approved compatible provider.",
    );
    return { issues };
  }
  const issuer = httpsUrl("FO_FIX_AUTH_ISSUER");
  const jwksUrl = httpsUrl("FO_FIX_AUTH_JWKS_URL");
  const authorizationUrl = httpsUrl("FO_FIX_OWNER_AUTHORIZATION_URL");
  const tokenUrl = httpsUrl("FO_FIX_OWNER_TOKEN_URL");
  for (const [field, value] of [
    ["FO_FIX_AUTH_JWKS_URL", jwksUrl],
    ["FO_FIX_OWNER_AUTHORIZATION_URL", authorizationUrl],
    ["FO_FIX_OWNER_TOKEN_URL", tokenUrl],
  ]) {
    if (issuer && value && new URL(value).origin !== new URL(issuer).origin)
      issue(
        field,
        "Use an endpoint on the pinned authorization-server origin.",
      );
  }
  const ownerSubject = required("FO_FIX_OWNER_SUBJECT");
  const ownerClientId = required("FO_FIX_OWNER_CLIENT_ID");
  const mcpClientId = required("FO_FIX_MCP_CLIENT_ID");
  const companionClientId =
    backend === "session" ? required("FO_FIX_COMPANION_CLIENT_ID") : undefined;
  const ids = [ownerClientId, mcpClientId, companionClientId].filter(Boolean);
  if (new Set(ids).size !== ids.length)
    issue(
      "FO_FIX_OWNER_CLIENT_ID",
      "Owner, MCP and companion OAuth clients must be distinct.",
    );
  if (issues.length) return { issues };
  return {
    config: {
      ...base,
      authMode: "oauth",
      issuer,
      jwksUrl,
      authorizationUrl,
      tokenUrl,
      ownerSubject,
      ownerClientId,
      mcpClientId,
      companionClientId,
    },
    issues,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const result = checkConfig(env);
  if (!result.config)
    throw new FixError(
      "CONFIGURATION_REQUIRED",
      `Configuration is incomplete: ${[...new Set(result.issues.map((i) => i.field))].join(", ")}. Run npm run diagnostics.`,
      503,
    );
  return result.config;
}

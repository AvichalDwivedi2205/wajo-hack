// Opt-in, one-request model smoke test. No .env loading, secret logging,
// credential copying, retries, file content, device data or repair execution.
const model = "claude-haiku-5-5"; // Official overview verified 2026-10-18; confirm account listing before use.
const secret = process.env.ANTHROPIC_API_KEY;
if (!secret) {
  console.log(
    JSON.stringify({
      test: "haiku-smoke",
      status: "blocked",
      model,
      reason:
        "ANTHROPIC_API_KEY unavailable in this process environment; no request made",
    }),
  );
  process.exit(2);
}
if (process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_AUTH_TOKEN) {
  console.log(
    JSON.stringify({
      test: "haiku-smoke",
      status: "blocked",
      model,
      reason:
        "Custom proxy/auth environment detected. Verify its supported mechanism before use; no credential moved or reconfigured.",
    }),
  );
  process.exit(2);
}
const headers = {
  "x-api-key": secret,
  "anthropic-version": "2023-06-01",
  "content-type": "application/json",
};
try {
  const listing = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers,
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!listing.ok) throw new Error(`model-list HTTP ${listing.status}`);
  const models = await listing.json();
  const target = models.data?.find((m) => m.id === model && m.line === "haiku");
  if (!target)
    throw new Error(
      "documented Haiku model not available in account model listing",
    );
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      model,
      max_tokens: 16,
      ...(target.capabilities?.thinking?.types?.disabled?.supported
        ? { thinking: { type: "disabled" } }
        : {}),
      messages: [{ role: "user", content: "Reply only with FO_FIX_OK." }],
    }),
  });
  if (!response.ok) throw new Error(`messages HTTP ${response.status}`);
  const data = await response.json();
  const success = data.content?.some(
    (block) => block.type === "text" && block.text.trim() === "FO_FIX_OK",
  );
  console.log(
    JSON.stringify({
      test: "haiku-smoke",
      status: success ? "passed" : "failed",
      model: data.model ?? model,
      input_tokens: data.usage?.input_tokens,
      output_tokens: data.usage?.output_tokens,
    }),
  );
  if (!success) process.exitCode = 1;
} catch (error) {
  // Never log fetch errors, bodies, headers or SDK objects which could carry a secret.
  const safe =
    error instanceof Error &&
    /^(model-list HTTP \d{3}|messages HTTP \d{3}|documented Haiku model not available in account model listing)$/.test(
      error.message,
    )
      ? error.message
      : "network or response failure (details intentionally withheld)";
  console.log(
    JSON.stringify({
      test: "haiku-smoke",
      status: "failed",
      model,
      reason: safe,
    }),
  );
  process.exitCode = 1;
}

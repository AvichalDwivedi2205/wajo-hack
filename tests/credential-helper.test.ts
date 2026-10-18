import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const html = readFileSync(
  new URL("../tools/offline-credentials.html", import.meta.url),
  "utf8",
);
test("offline helper is self-contained, CSP-pinned and denies network/form submission", () => {
  const csp = html.match(
    /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  )![1];
  for (const tag of ["script", "style"]) {
    const content = html.match(
      new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`),
    )![1];
    const hash = createHash("sha256").update(content).digest("base64");
    assert.ok(
      csp.includes(`${tag}-src 'sha256-${hash}'`),
      `${tag} CSP hash must match exact inline source`,
    );
  }
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
  ])
    assert.ok(csp.includes(directive));
  assert.doesNotMatch(
    html,
    /<(?:iframe|form)\b|\b(?:src|href)\s*=\s*["'](?:https?:|\/\/)/i,
  );
});
test("offline helper has no network/storage/telemetry APIs or implicit generation handler", () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  assert.doesNotMatch(
    script,
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b|document\.cookie|navigator\.(?:clipboard|serviceWorker|storage)|console\.|Math\.random|\beval\s*\(|new Function/,
  );
  assert.match(script, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/);
  assert.match(
    script,
    /crypto\.subtle\.digest\(\s*"SHA-256",\s*new TextEncoder\(\)\.encode\(value\),?\s*\)/,
  );
  assert.match(script, /generate\.addEventListener\("click", async/);
  assert.doesNotMatch(script, /addEventListener\("(?:load|DOMContentLoaded)"/);
});

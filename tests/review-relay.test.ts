import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type AddressInfo } from "node:net";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Engine } from "../src/core/engine.ts";
import type { OwnerService } from "../src/core/service.ts";
import { FixtureAdapter } from "../src/companion/adapter.ts";
import { createApp } from "../src/server/app.ts";
import { SessionBroker } from "../src/server/session.ts";
import { runDeviceSession } from "../src/companion/bridge.ts";
import { SyntheticReviewAdapter, PptxReviewAdapter } from "../src/review/adapter.ts";
import { setupPptxReview } from "../src/review/setup-pptx.ts";
import { readSources } from "../src/review/manifest.ts";
import { identityFixture, remoteFixture } from "./support/remote.ts";
import { reviewFixture, finished } from "./support/review.ts";
import { reviewJobSchema } from "../src/review/contracts.ts";
import { agentRequest } from "../src/shared/relay.ts";

for (const route of ["simulation", "pptx"] as const) test(
  route === "simulation" ? "three synthetic SDK/gateway/companion review runs preserve local authority and an export lasting beyond the 25-second audio timeout" : "three real Mac PPTX SDK/test-gateway/companion runs preserve strict metadata, local authority and approved undo (not actual Fo)",
  { timeout: 60_000, skip: route === "pptx" && process.platform !== "darwin" },
  async () => {
    let calls = 0;
    const actual = route === "pptx" ? new PptxReviewAdapter() : new SyntheticReviewAdapter();
    const c = await reviewFixture({
      synthetic: actual.synthetic,
      outputKind: route === "pptx" ? "pptx" : "simulation",
      execute: async (...args) => {
        calls++;
        if (calls === 1 && route === "simulation") await delay(26_000);
        await actual.execute(...args);
      },
    });
    if (route === "pptx") {
      // Replace only this freshly created disposable test fixture, before any
      // lease or snapshot exists. No user root or prior journal is involved.
      await rm(c.root, { recursive: true });
      await setupPptxReview(c.root, fileURLToPath(new URL("../fixtures/client-review/", import.meta.url)), fileURLToPath(new URL("../fixtures/keynote-seed/Alder-review-seed.pptx", import.meta.url)));
    }
    const audio = new Engine(c.store, new FixtureAdapter(c.store)),
      actor: OwnerService = audio;
    actor.review = c.engine;
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((r) => reservation.close(() => r()));
    const origin = `http://127.0.0.1:${port}`,
      { app, errors } = createApp(actor, port);
    app.use(errors);
    const server = app.listen(port, "127.0.0.1");
    await once(server, "listening");
    const post = async (
      path: string,
      body: unknown = {},
      headers: Record<string, string> = { Origin: origin },
    ) => {
      const r = await fetch(`${origin}/api/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { status: r.status, value: await r.json() };
    };
    const identity = await identityFixture("session"),
      broker = new SessionBroker(
        identity.config.deviceId!,
        Date.now,
        25_000,
        true,
      ),
      gateway = await remoteFixture(identity, broker);
    const controller = new AbortController();
    let connected!: () => void;
    const connection = new Promise<void>((r) => {
      connected = r;
    });
    const session = runDeviceSession({
      origin: identity.config.origin,
      accessToken: await identity.token("companion"),
      deviceId: identity.config.deviceId!,
      localPort: port,
      signal: controller.signal,
      fetcher: gateway.fetcher,
      onConnected: connected,
    }).then(
      () => true,
      () => false,
    );
    const client = new Client({
      name: "synthetic-review-regression-client",
      version: "1",
    });
    try {
      await connection;
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`${identity.config.origin}/mcp`),
          {
            fetch: gateway.fetcher,
            requestInit: {
              headers: {
                Authorization: `Bearer ${await identity.token("mcp")}`,
              },
            },
          },
        ),
      );
      const tools = (await client.listTools()).tools;
      assert.equal(tools.length, 11);
      assert.equal(tools.filter((t) => t.name.startsWith("review.")).length, 6);
      assert(tools.every((t) => t.inputSchema.additionalProperties === false));
      assert(!tools.some((t) => t.name === "review.approve"));
      const call = async (name: string, args: Record<string, unknown> = {}) =>
        client.callTool({ name, arguments: args });
      assert.equal((await call("review.snapshot")).isError, true);
      assert.equal((await post("permission")).status, 200);
      assert.equal((await call("review.snapshot")).isError, true);
      assert.equal((await post("review/permission", {}, {})).status, 403);
      assert.equal(
        (
          await post(
            "review/permission",
            {},
            { Origin: "https://foreign.invalid" },
          )
        ).status,
        403,
      );
      assert.equal((await post("review/permission")).status, 200);
      assert.equal(
        (await call("review.snapshot", { root: "/etc" })).isError,
        true,
      );
      const original = (await readSources(c.root)).digest;
      const owner = await gateway.login();
      for (let run = 0; run < 3; run++) {
        const snap = await call("review.snapshot");
        assert.notEqual(snap.isError, true);
        const snapshot = (snap.structuredContent as any).result;
        assert.equal(snapshot.metric.basisPoints, 450);
        const proposed = await call("review.prepare", {
          snapshotId: snapshot.id,
        });
        assert.notEqual(proposed.isError, true);
        const plan = (proposed.structuredContent as any).result;
        assert.equal(
          (await call("review.commit", { id: plan.id })).isError,
          true,
        );
        if (run === 0) {
          const cloud = await gateway.request(
            `/api/review/plans/${plan.id}/approve`,
            {
              method: "POST",
              headers: {
                Cookie: owner.cookie,
                Origin: identity.config.origin,
                "X-FoFix-CSRF": owner.csrf,
              },
              body: { digest: plan.digest },
            },
          );
          assert.equal(cloud.status, 403);
        }
        assert.equal(
          (
            await post(`review/plans/${plan.id}/approve`, {
              digest: plan.digest,
            })
          ).status,
          200,
        );
        assert.equal(calls, run);
        const start = Date.now(),
          commit = await call("review.commit", { id: plan.id });
        assert.notEqual(commit.isError, true);
        assert(Date.now() - start < 5000);
        const job = (commit.structuredContent as any).result;
        assert.equal(job.state, "queued");
        if (run === 0 && route === "simulation") {
          await delay(25_100);
          const pending = await call("review.verify", { id: job.id });
          assert.notEqual(pending.isError, true);
          assert.equal(
            (pending.structuredContent as any).result.state,
            "running",
          );
        }
        const result = await finished(c, job.id, route === "pptx" ? 1200 : 200);
        assert.equal(result.state, "succeeded", result.message);
        const verified = await call("review.verify", { id: job.id });
        assert.notEqual(verified.isError, true);
        assert.equal(
          (verified.structuredContent as any).result.verification.pages,
          3,
        );
        if (route === "pptx") {
          const metadata = (verified.structuredContent as any).result;
          assert.equal(metadata.outputKind, "pptx");
          assert.equal(metadata.nativeEvidence, undefined);
          assert.equal(metadata.pptxEvidence.renderer, "macos-quick-look+chrome");
          assert(metadata.artifacts.some((a: { name: string }) => a.name === "review.pptx"));
          const remoteArtifact = await gateway.request(`/api/review/jobs/${job.id}/artifacts/review.pptx`, { headers: { Cookie: owner.cookie } });
          assert.equal(remoteArtifact.status, 403);
        }
        assert.equal(JSON.stringify(verified).includes("base64"), false);
        assert.equal((await readSources(c.root)).digest, original);
        const pdf = await fetch(
          `${origin}/api/review/jobs/${job.id}/artifacts/review.pdf`,
        );
        assert.equal(pdf.status, 200);
        assert.match(pdf.headers.get("content-type")!, /application\/pdf/);
        const undoResponse = await call("review.undo", { id: job.id });
        const undo = (undoResponse.structuredContent as any).result;
        assert.equal(
          (await call("review.commit", { id: undo.id })).isError,
          true,
        );
        assert.equal(
          (
            await post(`review/plans/${undo.id}/approve`, {
              digest: undo.digest,
            })
          ).status,
          200,
        );
        assert.equal(
          (
            (await call("review.commit", { id: undo.id }))
              .structuredContent as any
          ).result.state,
          "undone",
        );
      }
      assert.equal(calls, 3);
    } finally {
      controller.abort();
      await session;
      await client.close();
      await gateway.close();
      await audio.shutdown();
      await c.engine.shutdown();
      await new Promise<void>((r) => server.close(() => r()));
      await c.close();
    }
  },
);
test("relay review allowlist and metadata schemas reject arbitrary commands, extra fields and document payloads", () => {
  for (const tool of [
    "review.approve",
    "review.shell",
    "review.open",
    "review.configure",
  ])
    assert.equal(agentRequest.safeParse({ tool, args: {} }).success, false);
  assert.equal(
    agentRequest.safeParse({
      tool: "review.commit",
      args: { id: "00000000-0000-4000-8000-000000000000", script: "unsafe" },
    }).success,
    false,
  );
  assert.equal(
    reviewJobSchema.safeParse({
      id: "00000000-0000-4000-8000-000000000000",
      pdfBase64: "synthetic-extra-field",
    }).success,
    false,
  );
});

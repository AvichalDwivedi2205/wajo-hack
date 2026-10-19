import type { Express, RequestHandler } from "express";
import { z } from "zod";
import type { OwnerService } from "../core/service.ts";
import type { ServerConfig } from "../server/config.ts";
import { invariant } from "../core/errors.ts";
import { ReviewEngine } from "./engine.ts";
import { SessionBroker } from "../server/session.ts";
import { PhoneReview, phoneLink, phoneRequest, phoneBytes, artifactName, type PhoneRequest } from "./phone.ts";
import {
  reviewApproval,
  reviewEmpty,
  reviewId,
  reviewPrepare,
} from "./contracts.ts";

export function mountReview(
  app: Express,
  engine: OwnerService,
  config: ServerConfig,
  human: RequestHandler,
) {
  const phone = config.mode === "local" && engine.review instanceof ReviewEngine ? new PhoneReview(engine.review) : undefined;
  const remote = (request: PhoneRequest) => {
    invariant(config.mode === "remote" && engine instanceof SessionBroker, "LOCAL_REVIEW_REQUIRED", "Use the local review interface.", 403);
    return (engine as SessionBroker).phoneReview(request);
  };
  const bytes = async (request: PhoneRequest) => {
    const result = phoneBytes.parse(await remote(request));
    const value = Buffer.from(result.base64, "base64");
    invariant(value.length <= 256 * 1024 && value.toString("base64") === result.base64, "INVALID_DEVICE_RESULT", "Invalid phone preview bytes.", 502);
    return value;
  };
  const local = () => {
    invariant(
      config.mode === "local" && engine.review instanceof ReviewEngine,
      "LOCAL_REVIEW_REQUIRED",
      "Open the local companion to grant or renew the three scoped folders.",
      403,
    );
    return engine.review as ReviewEngine;
  };
  const agent = () => {
    invariant(
      engine.review,
      "REVIEW_DISABLED",
      "Client review is not configured for this process.",
      404,
    );
    return engine.review!;
  };
  app.get("/api/review", async (_req, res) =>
    res.json(
      engine.review instanceof ReviewEngine && config.mode === "local"
        ? { ...engine.review.status(), phoneReview: phone?.state() }
        : await remote({ op: "status" }).catch(() => ({
            enabled: !!engine.review,
            authority: "companion",
            blockers: [
              "On the Mac, allow the three folders and explicitly enable this foreground phone session. Phone review cannot grant or renew folder access.",
            ],
          })),
    ),
  );
  // Loopback human routes only. Registering a link grants no authority.
  for (const action of ["link", "enable", "end", "disable", "relay"] as const) app.post(`/api/review/phone/${action}`, human, async (req, res) => {
    invariant(phone, "LOCAL_REVIEW_REQUIRED", "Phone session setup belongs to the Mac interface.", 403);
    if (action === "link") return res.json(phone!.register(phoneLink.parse(req.body)));
    if (action === "enable") return res.json(phone!.enable(phoneLink.parse(req.body)));
    if (action === "disable") { reviewEmpty.parse(req.body); return res.json(phone!.disable()); }
    if (action === "end") {
      const { sessionId } = z.object({ sessionId: z.uuid() }).strict().parse(req.body);
      phone!.end(sessionId); return res.json({ ended: true });
    }
    const { sessionId, request } = z.object({ sessionId: z.uuid(), request: phoneRequest }).strict().parse(req.body);
    return res.json(await phone!.invoke(sessionId, request));
  });
  app.post("/api/review/permission", human, async (req, res) => {
    reviewEmpty.parse(req.body);
    res.json(await local().grant());
  });
  app.delete("/api/review/permission", human, async (req, res) => {
    reviewEmpty.parse(req.body);
    res.json(config.mode === "local" ? local().revoke() : await remote({ op: "revoke" }));
  });
  app.post("/api/review/snapshot", async (req, res) => {
    reviewEmpty.parse(req.body);
    res.json(await agent().snapshot());
  });
  app.post("/api/review/prepare", async (req, res) => {
    const p = reviewPrepare.parse(req.body);
    res.json(await agent().prepare(p.snapshotId));
  });
  app.post("/api/review/commit", async (req, res) => {
    const p = reviewId.parse(req.body);
    res.json(await agent().commit(p.id));
  });
  app.post("/api/review/verify", async (req, res) => {
    const p = reviewId.parse(req.body);
    res.json(await agent().verify(p.id));
  });
  app.post("/api/review/undo", async (req, res) => {
    const p = reviewId.parse(req.body);
    res.json(await agent().undo(p.id));
  });
  app.post("/api/review/plans/:id/approve", human, async (req, res) => {
    const p = reviewId.parse(req.params),
      body = reviewApproval.parse(req.body);
    res.json(config.mode === "local" ? await local().approve(p.id, body.digest) : await remote({ op: "approve", id: p.id, digest: body.digest }));
  });
  app.post("/api/review/plans/:id/deny", human, async (req, res) => {
    const p = reviewId.parse(req.params);
    reviewEmpty.parse(req.body);
    res.json(config.mode === "local" ? local().deny(p.id) : await remote({ op: "deny", id: p.id }));
  });
  app.post("/api/review/jobs/:id/visual-approval", human, async (req, res) => {
    const p = reviewId.parse(req.params);
    reviewEmpty.parse(req.body);
    res.json(config.mode === "local" ? await local().visualApprove(p.id) : await remote({ op: "visual", id: p.id }));
  });
  app.post("/api/review/jobs/:id/attachment-approval", human, async (req, res) => {
    const p = reviewId.parse(req.params), body = reviewApproval.parse(req.body);
    res.json(config.mode === "local" ? await local().approveAttachments(p.id, body.digest) : await remote({ op: "share", id: p.id, digest: body.digest }));
  });
  app.get("/api/review/images/:role", async (req, res) => {
    const { role } = z
      .object({ role: z.enum(["before", "proposed"]) })
      .strict()
      .parse(req.params);
    const query = reviewApproval.parse(req.query);
    res.type("png").send(config.mode === "local" ? await local().image(role, query.digest) : await bytes({ op: "image", role, digest: query.digest }));
  });
  app.get("/api/review/jobs/:id/artifacts/:name", async (req, res) => {
    const { id, name } = z
      .object({
        id: z.uuid(),
        name: artifactName,
      })
      .strict()
      .parse(req.params);
    const data = config.mode === "local" ? await local().artifact(id, name) : await bytes({ op: "artifact", id, name });
    if (name === "review.pptx") res.attachment("review.pptx");
    res.type(name.endsWith("pdf") ? "pdf" : name.endsWith("pptx") ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "png").send(data);
  });
}

import type { Express, RequestHandler } from "express";
import { z } from "zod";
import type { OwnerService } from "../core/service.ts";
import type { ServerConfig } from "../server/config.ts";
import { invariant } from "../core/errors.ts";
import { ReviewEngine } from "./engine.ts";
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
  const local = () => {
    invariant(
      config.mode === "local" && engine.review instanceof ReviewEngine,
      "LOCAL_REVIEW_REQUIRED",
      "Open the local companion for the three scoped folders. Cloud/phone approval is not supported.",
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
  app.get("/api/review", (_req, res) =>
    res.json(
      engine.review instanceof ReviewEngine && config.mode === "local"
        ? engine.review.status()
        : {
            enabled: !!engine.review,
            authority: "companion",
            blockers: [
              "Review file permissions, previews and approvals are available only in the local companion.",
            ],
          },
    ),
  );
  app.post("/api/review/permission", human, async (req, res) => {
    reviewEmpty.parse(req.body);
    res.json(await local().grant());
  });
  app.delete("/api/review/permission", human, (req, res) => {
    reviewEmpty.parse(req.body);
    res.json(local().revoke());
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
    res.json(await local().approve(p.id, body.digest));
  });
  app.post("/api/review/plans/:id/deny", human, (req, res) => {
    const p = reviewId.parse(req.params);
    reviewEmpty.parse(req.body);
    res.json(local().deny(p.id));
  });
  app.post("/api/review/jobs/:id/visual-approval", human, async (req, res) => {
    const p = reviewId.parse(req.params);
    reviewEmpty.parse(req.body);
    res.json(await local().visualApprove(p.id));
  });
  app.get("/api/review/images/:role", async (req, res) => {
    const { role } = z
      .object({ role: z.enum(["before", "proposed"]) })
      .strict()
      .parse(req.params);
    const query = reviewApproval.parse(req.query);
    res.type("png").send(await local().image(role, query.digest));
  });
  app.get("/api/review/jobs/:id/artifacts/:name", async (req, res) => {
    const { id, name } = z
      .object({
        id: z.uuid(),
        name: z.enum(["review.pdf", "review.pptx", "page-1.png", "page-2.png", "page-3.png"]),
      })
      .strict()
      .parse(req.params);
    const bytes = await local().artifact(id, name);
    if (name === "review.pptx") res.attachment("review.pptx");
    res.type(name.endsWith("pdf") ? "pdf" : name.endsWith("pptx") ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "png").send(bytes);
  });
}

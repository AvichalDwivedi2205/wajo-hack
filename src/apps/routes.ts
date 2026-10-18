import type { Express, RequestHandler } from "express";
import { z } from "zod";
import type { OwnerService } from "../core/service.ts";
import { invariant } from "../core/errors.ts";
import { AppEngine } from "./engine.ts";
import { appOpenRequest, appPlanId } from "./contracts.ts";

export function mountApps(
  app: Express,
  engine: OwnerService,
  localMode: boolean,
  human: RequestHandler,
) {
  const local = () => {
    invariant(
      localMode && engine.apps instanceof AppEngine,
      "LOCAL_APP_APPROVAL_REQUIRED",
      "Open the local Mac companion to allow or approve app opening.",
      403,
    );
    return engine.apps as AppEngine;
  };
  const agent = () => {
    invariant(
      engine.apps,
      "APPS_DISABLED",
      "App opening is not enabled for this process.",
      404,
    );
    return engine.apps!;
  };
  const empty = z.object({}).strict();
  app.get("/api/apps", (_req, res) =>
    res.json(
      localMode && engine.apps instanceof AppEngine
        ? engine.apps.status()
        : {
            enabled: !!engine.apps,
            authority: "companion",
            plans: [],
            actions: [],
          },
    ),
  );
  app.post("/api/apps/permission", human, (req, res) => {
    empty.parse(req.body);
    res.json(local().grant());
  });
  app.delete("/api/apps/permission", human, (req, res) => {
    empty.parse(req.body);
    res.json(local().revoke());
  });
  app.post("/api/apps/inspect", async (req, res) => {
    empty.parse(req.body);
    res.json(await agent().inspect());
  });
  app.post("/api/apps/plans", async (req, res) => {
    const p = appOpenRequest.parse(req.body);
    res.json(await agent().propose(p.appId));
  });
  app.post("/api/apps/plans/:id/approve", human, async (req, res) => {
    const { id } = appPlanId.parse(req.params);
    const { digest } = z
      .object({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(req.body);
    res.json(await local().approve(id, digest));
  });
  app.post("/api/apps/plans/:id/deny", human, (req, res) => {
    const { id } = appPlanId.parse(req.params);
    empty.parse(req.body);
    res.json(local().deny(id));
  });
  app.post("/api/apps/plans/:id/execute", async (req, res) => {
    const { id } = appPlanId.parse(req.params);
    empty.parse(req.body);
    res.json(await agent().execute(id));
  });
}

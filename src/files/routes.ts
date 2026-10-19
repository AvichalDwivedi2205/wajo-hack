import type { Express, RequestHandler } from "express";
import { z } from "zod";
import type { OwnerService } from "../core/service.ts";
import { invariant } from "../core/errors.ts";
import { FolderEngine } from "./engine.ts";

/**
 * Folder consent lives only in the loopback Mac interface. The gateway, its
 * owner phone envelope and every MCP/machine credential have no grant route.
 */
export function mountFolders(app: Express, engine: OwnerService, localMode: boolean, human: RequestHandler) {
  const empty = z.object({}).strict();
  const local = () => {
    invariant(
      localMode && engine.files instanceof FolderEngine,
      "LOCAL_FOLDER_CONSENT_REQUIRED",
      "Folder access for Fo is allowed or revoked only in the Fo Reach interface on the Mac.",
      403,
    );
    return engine.files as FolderEngine;
  };
  app.get("/api/folders", (_req, res) =>
    res.json(
      localMode && engine.files instanceof FolderEngine
        ? engine.files.status()
        : { enabled: !!engine.files, authority: "companion", roots: [], lease: { active: false }, writes: [] },
    ),
  );
  app.post("/api/folders/lease", human, (req, res) => {
    empty.parse(req.body);
    res.json(local().grant());
  });
  app.delete("/api/folders/lease", human, (req, res) => {
    empty.parse(req.body);
    res.json(local().revoke());
  });
}

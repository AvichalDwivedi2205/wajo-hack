import { z } from "zod";

export const appId = z.enum(["spotify", "music", "calculator"]);
export type AppId = z.infer<typeof appId>;
export const supportedApps = {
  spotify: { name: "Spotify", bundleId: "com.spotify.client" },
  music: { name: "Music", bundleId: "com.apple.Music" },
  calculator: { name: "Calculator", bundleId: "com.apple.calculator" },
} as const;
export const appFact = z
  .object({
    id: appId,
    name: z.string().min(1).max(64),
    bundleId: z.string().min(1).max(128),
    installed: z.boolean(),
    identity: z.string().max(4096),
    running: z.boolean(),
    active: z.boolean(),
  })
  .strict();
export type AppFact = z.infer<typeof appFact>;
export const appPlan = z
  .object({
    id: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    appId,
    title: z.string().max(128),
    effect: z.string().max(256),
    risk: z.string().max(512),
    identity: z.string().max(4096),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    status: z.enum(["pending", "approved", "denied", "consumed"]),
  })
  .strict();
export type AppPlan = z.infer<typeof appPlan>;
export const appAction = z
  .object({
    id: z.uuid(),
    planId: z.uuid(),
    appId,
    source: z.enum(["fixture", "macos"]),
    state: z.enum(["executing", "succeeded", "uncertain"]),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    observed: z.string().max(512),
    after: appFact.optional(),
  })
  .strict();
export type AppAction = z.infer<typeof appAction>;
export const appInspection = z
  .object({
    source: z.enum(["fixture", "macos"]),
    apps: z.array(appFact).length(3),
    plans: z.array(appPlan).max(20),
    actions: z.array(appAction).max(20),
  })
  .strict();
export type AppInspection = z.infer<typeof appInspection>;
export interface AppAgent {
  inspect(): Promise<AppInspection>;
  propose(id: AppId): Promise<AppPlan>;
  execute(id: string): Promise<AppAction>;
}
export const appOpenRequest = z.object({ appId }).strict();
export const appPlanId = z.object({ id: z.uuid() }).strict();

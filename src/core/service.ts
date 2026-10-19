import type {
  Action,
  AppStatus,
  Plan,
  Recipe,
  Snapshot,
} from "../shared/types.ts";
import type { ReviewAgent } from "../review/contracts.ts";
import type { AppAgent } from "../apps/contracts.ts";
import type { FilesAgent } from "../files/contracts.ts";
export interface AgentService {
  apps?: AppAgent;
  review?: ReviewAgent;
  files?: FilesAgent;
  status(audience?: "local" | "agent"): AppStatus | Promise<AppStatus>;
  inspect(): Promise<Snapshot>;
  propose(recipe: Recipe, deviceId?: string): Promise<Plan>;
  execute(planId: string): Promise<Action>;
  proposeUndo(actionId: string): Promise<Plan>;
}
export interface OwnerService extends AgentService {
  grantPermission(): AppStatus | Promise<AppStatus>;
  revokePermission(): AppStatus | Promise<AppStatus>;
  approve(planId: string, digest: string): Promise<Plan>;
  deny(planId: string): Promise<Plan>;
  shutdown(): Promise<void>;
}

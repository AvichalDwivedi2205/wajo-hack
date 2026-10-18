export type Mode = "fixture" | "macos";
export type OutputDevice = {
  id: string;
  name: string;
  transport: string;
  alive: boolean;
  muted: boolean | null;
};
export type DeviceState = { outputId: string; devices: OutputDevice[] };
export type Snapshot = DeviceState & {
  revision: string;
  capturedAt: string;
  source: Mode;
};
export type Change =
  | { kind: "set-output"; deviceId: string }
  | { kind: "set-mute"; deviceId: string; muted: boolean };
export type Plan = {
  id: string;
  digest: string;
  title: string;
  explanation: string;
  effect: string;
  risk: string;
  change: Change;
  before: Snapshot;
  expected: DeviceState;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "consumed" | "denied";
  approvedAt?: string;
  direction: "repair" | "undo";
  sourceActionId?: string;
};
export type Verification = {
  status: "passed" | "failed" | "unavailable";
  expected: string;
  observed: string;
  checkedAt: string;
};
export type Action = {
  id: string;
  planId: string;
  title: string;
  source: Mode;
  direction: "repair" | "undo";
  sourceActionId?: string;
  state: "executing" | "succeeded" | "failed" | "uncertain";
  startedAt: string;
  completedAt?: string;
  before: Snapshot;
  after?: Snapshot;
  change: Change;
  verification?: Verification;
  error?: string;
  undoneBy?: string;
};
export type AuditEvent = {
  id: string;
  at: string;
  kind: string;
  subjectId?: string;
  detail: string;
};
export type AppStatus = {
  name: "Fo Fix";
  mode: Mode | "unavailable";
  companion: "fixture" | "local" | "offline";
  approvalAuthority?: "here" | "companion";
  deviceSession?: { connected: boolean; expiresAt?: string };
  lifecycle: "ready" | "stopping";
  permission: { active: boolean; expiresAt?: string; scope: string };
  capabilities: string[];
  fo: { connected: false; status: string };
  history: {
    redacted: boolean;
    truncated?: boolean;
    actionCount: number;
    planCount: number;
    eventCount: number;
  };
  actions: Action[];
  plans: Plan[];
  events: AuditEvent[];
};
export type Recipe = "switch-output" | "unmute-output";

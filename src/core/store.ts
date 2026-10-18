import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { Action, AuditEvent, DeviceState, Plan } from "../shared/types.ts";

export const initialFixture: DeviceState = {
  outputId: "fixture-hdmi",
  devices: [
    {
      id: "fixture-speakers",
      name: "MacBook Speakers",
      transport: "Built-in",
      alive: true,
      muted: false,
    },
    {
      id: "fixture-hdmi",
      name: "Studio Display",
      transport: "Display audio",
      alive: true,
      muted: false,
    },
    {
      id: "fixture-headphones",
      name: "Desk Headphones",
      transport: "USB",
      alive: true,
      muted: true,
    },
  ],
};
export type StoredData = {
  grant: { expiresAt: string } | null;
  plans: Plan[];
  actions: Action[];
  events: AuditEvent[];
  fixture: DeviceState;
};
export class Store {
  private db: DatabaseSync;
  data: StoredData;
  constructor(path = ":memory:") {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    // Keep one writer for the lifetime of the companion. A second process must
    // fail at startup instead of replaying approvals from a stale memory copy.
    this.db.exec(
      "PRAGMA busy_timeout=1000; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)",
    );
    const row = this.db.prepare("SELECT data FROM state WHERE id = 1").get() as
      { data: string } | undefined;
    this.data = row
      ? JSON.parse(row.data)
      : {
          grant: null,
          plans: [],
          actions: [],
          events: [],
          fixture: structuredClone(initialFixture),
        };
    this.save();
  }
  save() {
    this.db
      .prepare(
        "INSERT INTO state(id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(JSON.stringify(this.data));
  }
  close() {
    this.db.close();
  }
}

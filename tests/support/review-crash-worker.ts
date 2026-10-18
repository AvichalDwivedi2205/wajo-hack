// Fault-injection child: killed by the parent after a durable running job and
// partial export exist. Never touches native apps, credentials or external data.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { ReviewEngine } from "../../src/review/engine.ts";
import { Store } from "../../src/core/store.ts";
import { gate } from "./review.ts";

const start = once(process, "message");
process.send!("ready");
await start;
const [root, database] = process.argv.slice(2);
const store = new Store(database),
  entered = gate();
const engine = new ReviewEngine(store, root, {
  synthetic: true,
  async execute(directory, _plan, _sources, _signal, boundary) {
    await boundary();
    await writeFile(
      join(directory, "review.pdf"),
      "%PDF-1.7\nINCOMPLETE EXPORT",
    );
    entered.resolve();
    await new Promise(() => {});
  },
});
await engine.grant();
const snapshot = await engine.snapshot();
const create = await engine.prepare(snapshot.id);
await engine.approve(create.id, create.digest);
const pending = await engine.prepare(snapshot.id);
const approved = await engine.prepare(snapshot.id);
await engine.approve(approved.id, approved.digest);
const job = await engine.commit(create.id);
await entered.promise;
process.send!({
  createId: create.id,
  jobId: job.id,
  pendingId: pending.id,
  approvedId: approved.id,
});

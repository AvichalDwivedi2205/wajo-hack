// Disposable synthetic folders only; never a user's real vault or ~/.fo-reach.
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/store.ts";
import { FolderEngine } from "../../src/files/engine.ts";
import { configureRoots } from "../../src/files/paths.ts";
import { directPdf } from "../../src/files/slides.ts";
import type { SlidesCreate } from "../../src/files/contracts.ts";

export async function folderFixture(options: { renderer?: "direct" | "native" } = {}) {
  // Canonical temp path: macOS /var and /tmp are symlinks and roots refuse them.
  const base = await mkdtemp(join(await realpath(tmpdir()), "fo-folders-"));
  const vault = join(base, "vault"), outside = join(base, "outside"), state = join(base, "state");
  await mkdir(join(vault, "Notes", "Deep", "Deeper"), { recursive: true });
  await mkdir(join(vault, ".obsidian"));
  await mkdir(outside);
  await writeFile(join(vault, "Notes", "plan.md"), "# Plan\nShip the Alpha launch\nalpha owner: Maya\n");
  await writeFile(join(vault, "Notes", "Deep", "Deeper", "far.md"), "deep alpha\n");
  await writeFile(join(vault, "Notes", "data.csv"), "name,value\nALPHA,1\n");
  await writeFile(join(vault, "Notes", "script.js"), "alpha() // not a searchable text type\n");
  await writeFile(join(vault, ".obsidian", "app.json"), '{"alpha":true}');
  await writeFile(join(vault, "binary.md"), Buffer.from([0x23, 0x00, 0x01, 0x02]));
  await writeFile(join(outside, "secret.md"), "outside alpha secret\n");
  await symlink(join(outside, "secret.md"), join(vault, "link.md"));
  await symlink(outside, join(vault, "linkdir"));
  await link(join(outside, "secret.md"), join(vault, "hard.md"));
  const store = new Store();
  let now = Date.now();
  const roots = configureRoots([vault], { home: join(base, "home"), stateDirectory: state });
  const engine = new FolderEngine(store, roots, {
    stateDirectory: state,
    clock: () => now,
    ...(options.renderer === "native" ? {} : { renderer: { name: "pdf-lib" as const, render: directPdf } }),
  });
  return {
    base, vault, outside, state, store, engine, roots,
    advance: (ms: number) => { now += ms; },
    close: async () => { await engine.shutdown(); store.close(); await rm(base, { recursive: true, force: true }); },
  };
}
export const deck = (fileName = "Quarterly review"): SlidesCreate => ({
  title: "Quarterly review",
  fileName,
  slides: [
    { title: "Quarterly review", note: "Welcome everyone.\nKeep it short." },
    { title: "Where we stand", stats: [{ value: "4.5%", label: "Retained conversion" }, { value: "540", label: "Retained buyers" }], bullets: ["Below the 5.0% gate", "Hold the rollout"] },
    { title: "Next steps", bullets: ["Instrument checkout", "Read out on 25 October", "Owner: Maya <ops> & co"] },
  ],
});

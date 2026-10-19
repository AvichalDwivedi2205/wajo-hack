import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import { PDFDocument } from "pdf-lib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store } from "../src/core/store.ts";
import { Engine } from "../src/core/engine.ts";
import { FixtureAdapter } from "../src/companion/adapter.ts";
import { mcpEncodedBytes } from "../src/files/engine.ts";
import { configureRoots, folderArguments } from "../src/files/paths.ts";
import { chromePath } from "../src/files/slides.ts";
import { createMcpServer } from "../src/server/mcp.ts";
import { MAX_MCP_RESULT_BYTES, DEVICE_SESSION_MS } from "../src/shared/limits.ts";
import { agentRequest } from "../src/shared/relay.ts";
import type { SlidesCreate } from "../src/files/contracts.ts";
import { folderFixture as fixture, deck } from "./support/files.ts";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const code = (expected: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, expected, (error as Error).message);
  return true;
};

test("folder roots are configured only locally, canonical, non-overlapping and never home, disk or state", async () => {
  const base = await mkdtemp(join(await realpath(tmpdir()), "fo-roots-"));
  try {
    const a = join(base, "a"), b = join(a, "b"), state = join(base, "state"), home = join(base, "home");
    await mkdir(b, { recursive: true });
    await mkdir(home);
    await symlink(a, join(base, "alias"));
    const configure = (paths: string[]) => configureRoots(paths, { home, stateDirectory: state });
    assert.deepEqual(configure([a]).map((r) => r.name), ["a"]);
    for (const bad of [[join(base, "alias")], ["relative/path"], ["/"], [home], [base], [a, b], [join(base, "missing")]])
      assert.throws(() => configure(bad), code("FOLDER_CONFIGURATION"), bad.join(","));
    assert.throws(() => configureRoots([base], { home: join(base, "elsewhere"), stateDirectory: join(base, "state") }), code("FOLDER_CONFIGURATION"));
    assert.deepEqual(folderArguments(["--allow-folder", a, `--allow-folder=${b}`, "--review-demo"], { FO_FIX_ALLOWED_FOLDERS: `${a}\n${home}` }), [a, b, home]);
    assert.throws(() => folderArguments(["--allow-folder"], {}), code("FOLDER_CONFIGURATION"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("every folder tool refuses without the local lease; lease expires at three hours and revocation is immediate", async () => {
  const c = await fixture();
  try {
    const calls = [
      () => c.engine.list({ path: "" }),
      () => c.engine.read({ path: "Notes/plan.md" }),
      () => c.engine.search({ query: "alpha" }),
      () => c.engine.write({ path: "Notes/new.md", content: "x", mode: "create" }),
      () => c.engine.undoWrite({ writeId: crypto.randomUUID() }),
      () => c.engine.createSlides(deck()),
      () => c.engine.readArtifact({ path: "Presentations/x.pdf", offset: 0 }),
    ];
    for (const call of calls) await assert.rejects(call(), code("FOLDER_LEASE_REQUIRED"));
    const granted = c.engine.grant();
    assert.equal(granted.lease.active, true);
    assert.equal(Date.parse(granted.lease.expiresAt!) - Date.now() <= DEVICE_SESSION_MS + 1000, true);
    assert.equal((await c.engine.list({ path: "" })).root, c.vault);
    c.advance(DEVICE_SESSION_MS + 1);
    await assert.rejects(c.engine.list({ path: "" }), code("FOLDER_LEASE_REQUIRED"));
    c.engine.grant();
    await c.engine.list({ path: "" });
    c.engine.revoke();
    await assert.rejects(c.engine.read({ path: "Notes/plan.md" }), code("FOLDER_LEASE_REQUIRED"));
    // No MCP tool can grant access.
    assert(!agentRequest.options.some((o) => /grant|lease|allow/.test(o.shape.tool.value)));
  } finally {
    await c.close();
  }
});

test("paths stay inside the roots: traversal, absolute escapes, symlinks, hard links and hidden folders are refused", async () => {
  const c = await fixture();
  try {
    c.engine.grant();
    const listed = await c.engine.list({ path: "", depth: 3 });
    const names = listed.entries.map((e) => e.path.slice(c.vault.length + 1));
    assert(names.includes("Notes/Deep/Deeper") && !names.includes("Notes/Deep/Deeper/far.md"));
    assert(!names.some((n) => n.startsWith(".obsidian")) && listed.hiddenSkipped >= 1);
    assert.equal(listed.entries.find((e) => e.name === "link.md")?.type, "symlink");
    assert.equal(listed.entries.find((e) => e.name === "linkdir")?.type, "symlink");
    assert.deepEqual(listed.roots, [{ name: "vault", path: c.vault }]);
    for (const [path, expected] of [
      ["../outside/secret.md", "FILES_PATH"],
      ["Notes/../../outside/secret.md", "FILES_PATH"],
      [join(c.outside, "secret.md"), "FILES_OUTSIDE_ROOT"],
      [`${c.vault}-sibling/secret.md`, "FILES_OUTSIDE_ROOT"],
      ["link.md", "FILES_SYMLINK"],
      ["linkdir/secret.md", "FILES_SYMLINK"],
      [".obsidian/app.json", "FILES_HIDDEN"],
      ["Notes\\..\\..\\outside\\secret.md", "FILES_PATH"],
      ["hard.md", "FILES_HARD_LINK"],
      ["binary.md", "FILES_BINARY"],
      ["Notes", "FILES_NOT_FILE"],
      ["Notes/missing.md", "FILES_NOT_FOUND"],
      ...(process.platform === "darwin" ? [["notes/plan.md", "FILES_PATH"] as const] : []),
    ] as const)
      await assert.rejects(c.engine.read({ path }), code(expected), path);
    if (process.platform === "darwin")
      await assert.rejects(c.engine.write({ path: "notes/case.md", content: "x", mode: "create" }), code("FILES_PATH"));
    await assert.rejects(c.engine.list({ path: "linkdir" }), code("FILES_SYMLINK"));
    for (const [path, expected] of [
      ["linkdir/new.md", "FILES_SYMLINK"],
      [join(c.outside, "new.md"), "FILES_OUTSIDE_ROOT"],
      ["../outside/new.md", "FILES_PATH"],
      [".obsidian/plugins.json", "FILES_HIDDEN"],
      ["Notes/run.sh", "FILES_TYPE"],
      ["Notes/deck.pptx", "FILES_TYPE"],
      ["link.md", "FILES_SYMLINK"],
    ] as const)
      await assert.rejects(c.engine.write({ path, content: "x", mode: "overwrite" }), code(expected), path);
    assert.equal(await readFile(join(c.outside, "secret.md"), "utf8"), "outside alpha secret\n");
    assert.deepEqual((await readdir(c.outside)).sort(), ["secret.md"]);
    // Absolute paths inside the root work and resolve to the same file.
    assert.equal((await c.engine.read({ path: join(c.vault, "Notes", "plan.md") })).text.startsWith("# Plan"), true);
  } finally {
    await c.close();
  }
});

test("reads page through UTF-8 text without splitting characters and stay under the MCP result cap", async () => {
  const c = await fixture();
  try {
    c.engine.grant();
    const text = "é€😀".repeat(3000) + "\n";
    await writeFile(join(c.vault, "utf.md"), text);
    let offset = 0, assembled = "";
    for (let i = 0; i < 100; i++) {
      const part = await c.engine.read({ path: "utf.md", offset, maxBytes: 1000 });
      assert(part.bytes <= 1000);
      assembled += part.text;
      offset = part.nextOffset;
      if (!part.truncated) break;
    }
    assert.equal(assembled, text);
    const mid = await c.engine.read({ path: "utf.md", offset: 1, maxBytes: 100 });
    assert.equal(mid.offset, 2); // skipped the continuation byte of "é"
    // Quote-heavy 256 KiB still fits after double JSON encoding in MCP results.
    await writeFile(join(c.vault, "quotes.md"), '"\\'.repeat(128 * 1024));
    const big = await c.engine.read({ path: "quotes.md", maxBytes: 256 * 1024 });
    assert.equal(big.truncated, true);
    assert(mcpEncodedBytes(big) <= MAX_MCP_RESULT_BYTES);
    const store = new Store(), audio = new Engine(store, new FixtureAdapter(store));
    const server = createMcpServer(Object.assign(audio, { files: c.engine }));
    const client = new Client({ name: "synthetic-folder-cap", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const names = (await client.listTools()).tools.map((t) => t.name);
      for (const name of ["files.list", "files.read", "files.search", "files.write", "files.undo_write", "files.read_artifact", "slides.create"])
        assert(names.includes(name), name);
      assert(!names.includes("files.share_download") && !names.some((n) => /grant|lease|allow|shell|command|exec/.test(n) && n !== "fo_fix_execute_approved"));
      const result = await client.callTool({ name: "files.read", arguments: { path: "quotes.md", maxBytes: 256 * 1024 } });
      assert.notEqual(result.isError, true);
      assert(Buffer.byteLength(JSON.stringify(result)) <= MAX_MCP_RESULT_BYTES);
      assert.equal((await client.callTool({ name: "files.read", arguments: { path: "quotes.md", maxBytes: 256 * 1024 + 1 } })).isError, true);
      assert.equal((await client.callTool({ name: "files.list", arguments: { path: "", depth: 4 } })).isError, true);
      assert.equal((await client.callTool({ name: "files.list", arguments: { path: "", command: "ls" } })).isError, true);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  } finally {
    await c.close();
  }
});

test("search is case-insensitive over text types only, skips hidden/symlinked/outside files and honours limits", async () => {
  const c = await fixture();
  try {
    c.engine.grant();
    const all = await c.engine.search({ query: "ALPHA" });
    const files = all.matches.map((m) => m.path.slice(c.vault.length + 1));
    assert.deepEqual([...new Set(files)].sort(), ["Notes/Deep/Deeper/far.md", "Notes/data.csv", "Notes/plan.md"]);
    assert.deepEqual(all.matches.filter((m) => m.path.endsWith("plan.md")).map((m) => m.line), [2, 3]);
    assert.equal(all.truncated, false);
    const limited = await c.engine.search({ query: "alpha", maxResults: 1 });
    assert.equal(limited.matches.length, 1);
    assert.equal(limited.truncated, true);
    const scoped = await c.engine.search({ query: "alpha", path: "Notes/Deep" });
    assert.deepEqual(scoped.matches.map((m) => m.line), [1]);
    await writeFile(join(c.vault, "long.md"), "x".repeat(5000) + "needle" + "y".repeat(5000));
    const long = await c.engine.search({ query: "NEEDLE" });
    assert.equal(long.matches.length, 1);
    assert(long.matches[0].snippet.length <= 242 && long.matches[0].snippet.includes("needle"));
    await writeFile(join(c.vault, "huge.md"), "needle\n".repeat(400_000));
    const skipped = await c.engine.search({ query: "needle" });
    assert(skipped.skipped >= 1 && skipped.matches.every((m) => !m.path.endsWith("huge.md")));
    await assert.rejects(c.engine.search({ query: "alpha", path: "linkdir" }), code("FILES_SYMLINK"));
    await assert.rejects(c.engine.search({ query: "alpha", maxResults: 101 }), code("INVALID_REQUEST"));
  } finally {
    await c.close();
  }
});

test("writes keep private backups and undo restores only while the file still has the written hash", async () => {
  const c = await fixture();
  try {
    c.engine.grant();
    const created = await c.engine.write({ path: "Inbox/Today/todo.md", content: "- [ ] call\n", mode: "create" });
    assert.equal(created.created, true);
    assert.equal(created.sha256, sha("- [ ] call\n"));
    assert.equal(created.backupPath, undefined);
    await assert.rejects(c.engine.write({ path: "Inbox/Today/todo.md", content: "again", mode: "create" }), code("FILES_EXISTS"));
    await assert.rejects(c.engine.write({ path: "Inbox/none.md", content: "x", mode: "append" }), code("FILES_NOT_FOUND"));
    const plan = join(c.vault, "Notes", "plan.md"), original = await readFile(plan, "utf8");
    const mode = (await stat(plan)).mode;
    const overwrite = await c.engine.write({ path: "Notes/plan.md", content: "# New plan\n", mode: "overwrite" });
    assert.equal(await readFile(plan, "utf8"), "# New plan\n");
    assert.equal(await readFile(overwrite.backupPath!, "utf8"), original);
    assert(overwrite.backupPath!.startsWith(join(c.state, "backups") + "/"));
    assert(overwrite.backupPath!.endsWith(join("vault", "Notes", "plan.md")));
    assert.equal((await stat(overwrite.backupPath!)).mode & 0o777, 0o600);
    assert.equal((await stat(plan)).mode, mode);
    const append = await c.engine.write({ path: "Notes/plan.md", content: "- more\n", mode: "append" });
    assert.equal(await readFile(plan, "utf8"), "# New plan\n- more\n");
    assert.equal(append.sha256, sha("# New plan\n- more\n"));
    assert.equal(await readFile(append.backupPath!, "utf8"), "# New plan\n");
    // Undo in the wrong order is refused because the hash no longer matches.
    await assert.rejects(c.engine.undoWrite({ writeId: overwrite.writeId }), code("FILES_CHANGED_SINCE_WRITE"));
    assert.equal((await c.engine.undoWrite({ writeId: append.writeId })).action, "restored");
    assert.equal(await readFile(plan, "utf8"), "# New plan\n");
    await assert.rejects(c.engine.undoWrite({ writeId: append.writeId }), code("FILES_UNDO_UNAVAILABLE"));
    assert.equal((await c.engine.undoWrite({ writeId: overwrite.writeId })).sha256, sha(original));
    assert.equal(await readFile(plan, "utf8"), original);
    // A newer human edit blocks undo of an earlier Fo write.
    const edited = await c.engine.write({ path: "Notes/plan.md", content: "fo edit\n", mode: "overwrite" });
    await writeFile(plan, "owner edit after Fo\n");
    await assert.rejects(c.engine.undoWrite({ writeId: edited.writeId }), code("FILES_CHANGED_SINCE_WRITE"));
    assert.equal(await readFile(plan, "utf8"), "owner edit after Fo\n");
    // Undo of a create removes the file and only the folders it created.
    assert.equal((await c.engine.undoWrite({ writeId: created.writeId })).action, "deleted");
    assert.equal(existsSync(join(c.vault, "Inbox")), false);
    await assert.rejects(c.engine.write({ path: "Notes/big.md", content: "x".repeat(512 * 1024 + 1), mode: "create" }), code("INVALID_REQUEST"));
    await assert.rejects(c.engine.write({ path: "Notes/nul.md", content: "a\u0000b", mode: "create" }), code("INVALID_REQUEST"));
    assert.equal((await readdir(join(c.vault, "Notes"))).some((n) => n.startsWith(".fo-reach-")), false);
    // The journal survives restart; unfinished records become uncertain, never retried.
    const records = c.store.data.files!.writes;
    assert(records.every((r) => ["written", "undone"].includes(r.state)));
    assert.equal(c.engine.status().writes.length, 4);
  } finally {
    await c.close();
  }
});

test("audit records each tool call without contents, queries or note text", async () => {
  const c = await fixture();
  try {
    await assert.rejects(c.engine.read({ path: "Notes/plan.md" }), code("FOLDER_LEASE_REQUIRED"));
    c.engine.grant();
    await c.engine.read({ path: "Notes/plan.md" });
    await c.engine.search({ query: "confidential-query-text" });
    await c.engine.write({ path: "Notes/secret.md", content: "TOP-SECRET-CONTENT", mode: "create" });
    await assert.rejects(c.engine.read({ path: "link.md" }), code("FILES_SYMLINK"));
    const audit = await readFile(join(c.state, "audit.jsonl"), "utf8");
    const lines = audit.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.tool, l.code]), [
      ["files.read", "FOLDER_LEASE_REQUIRED"], ["lease.grant", "OK"], ["files.read", "OK"], ["files.search", "OK"], ["files.write", "OK"], ["files.read", "FILES_SYMLINK"],
    ]);
    assert.equal(lines[4].path, join(c.vault, "Notes", "secret.md"));
    assert.equal(lines[4].bytes, 18);
    assert(lines.every((l) => typeof l.at === "string"));
    assert(!/TOP-SECRET|confidential-query|Ship the Alpha/.test(audit));
    assert.equal((await stat(join(c.state, "audit.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await stat(c.state)).mode & 0o777, 0o700);
  } finally {
    await c.close();
  }
});

test("slides.create writes a real N-slide PPTX and a matching N-page PDF, never overwrites, and undo removes it", async () => {
  const c = await fixture();
  try {
    c.engine.grant();
    const first = await c.engine.createSlides(deck());
    assert.equal(first.pptx.path, join(c.vault, "Presentations", "Quarterly review.pptx"));
    assert.equal(first.pdf.path, join(c.vault, "Presentations", "Quarterly review.pdf"));
    assert.equal(first.renderer, "pdf-lib");
    const pptx = await readFile(first.pptx.path), pdf = await readFile(first.pdf.path);
    assert.equal(sha(pptx), first.pptx.sha256);
    assert.equal(sha(pdf), first.pdf.sha256);
    const parts = unzipSync(pptx);
    assert.deepEqual(Object.keys(parts).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(), ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml"]);
    assert.match(strFromU8(parts["ppt/slides/slide3.xml"]), /<a:t>Owner: Maya &lt;ops&gt; &amp; co<\/a:t>/);
    assert.match(strFromU8(parts["ppt/slides/slide2.xml"]), /<a:t>4\.5%<\/a:t>/);
    assert.match(strFromU8(parts["ppt/notesSlides/notesSlide1.xml"]), /Keep it short\./);
    assert(!parts["ppt/notesSlides/notesSlide2.xml"]);
    assert.match(strFromU8(parts["[Content_Types].xml"]), /presentationml\.slide\+xml/);
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 3);
    assert.equal(first.pageCount, 3);
    const second = await c.engine.createSlides(deck());
    assert.equal(second.pptx.path, join(c.vault, "Presentations", "Quarterly review (2).pptx"));
    assert.deepEqual(await readFile(first.pptx.path), pptx);
    const chunk = await c.engine.readArtifact({ path: first.pdf.path, offset: 0 });
    assert.equal(chunk.sha256, first.pdf.sha256);
    assert.equal(chunk.totalBytes, pdf.length);
    await assert.rejects(c.engine.readArtifact({ path: "Notes/plan.md", offset: 0 }), code("FILES_SHARE_UNAVAILABLE"));
    await assert.rejects(c.engine.createSlides({ ...deck(), fileName: "../escape" }), code("INVALID_REQUEST"));
    await assert.rejects(c.engine.createSlides({ ...deck(), folder: c.outside }), code("FILES_OUTSIDE_ROOT"));
    await assert.rejects(c.engine.createSlides({ ...deck(), slides: deck().slides.slice(0, 1) }), code("INVALID_REQUEST"));
    for (const id of [second.pptx.writeId, second.pdf.writeId]) assert.equal((await c.engine.undoWrite({ writeId: id })).action, "deleted");
    assert.deepEqual((await readdir(join(c.vault, "Presentations"))).sort(), ["Quarterly review.pdf", "Quarterly review.pptx"]);
    // Re-allowing ends sharing of decks from the previous lease.
    c.engine.grant();
    await assert.rejects(c.engine.readArtifact({ path: first.pdf.path, offset: 0 }), code("FILES_SHARE_UNAVAILABLE"));
  } finally {
    await c.close();
  }
});

test("macOS Quick Look + Chrome export produces one PDF page per slide", {
  skip: process.platform !== "darwin" || !existsSync(chromePath) || !existsSync("/usr/bin/qlmanage"),
  timeout: 120_000,
}, async () => {
  const c = await fixture({ renderer: "native" });
  try {
    c.engine.grant();
    const ten: SlidesCreate = { ...deck("Ten slides"), slides: Array.from({ length: 10 }, (_, i) => i === 0 ? { title: "Ten slides" } : { title: `Slide ${i + 1}`, bullets: [`Point ${i + 1}`, "Another point"] }) };
    const result = await c.engine.createSlides(ten);
    assert.equal(result.renderer, "macos-quick-look+chrome");
    assert.equal(result.pageCount, 10);
    assert.equal((await PDFDocument.load(await readFile(result.pdf.path))).getPageCount(), 10);
    assert.equal(Object.keys(unzipSync(await readFile(result.pptx.path))).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length, 10);
  } finally {
    await c.close();
  }
});

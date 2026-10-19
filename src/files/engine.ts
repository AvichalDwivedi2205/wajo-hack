import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { z } from "zod";
import type { Store } from "../core/store.ts";
import { FixError, invariant } from "../core/errors.ts";
import { DEVICE_SESSION_MS, MAX_MCP_RESULT_BYTES } from "../shared/limits.ts";
import { FolderAudit } from "./audit.ts";
import {
  FILES_LIMITS,
  artifactRead,
  filesList,
  filesRead,
  filesSearch,
  filesUndo,
  filesWrite,
  slidesCreate,
  textExtensions,
  sharedExtensions,
  type ArtifactChunk,
  type FilesAgent,
  type FilesListResult,
  type FilesReadResult,
  type FilesSearchResult,
  type FilesUndoResult,
  type FilesWriteResult,
  type FolderStatus,
  type SlidesCreate,
  type SlidesResult,
  type WriteRecord,
} from "./contracts.ts";
import { extensionOf, hiddenName, resolvePath, type Resolved, type Root } from "./paths.ts";
import { buildPptx, defaultRenderer, pdfPageCount, verifyPptx, type DeckRenderer, type PdfRender } from "./slides.ts";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
// The device result is serialized twice (text + structured) by the MCP layer.
export const mcpEncodedBytes = (data: unknown) =>
  Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: { result: data } }));
const RESULT_BUDGET = MAX_MCP_RESULT_BYTES - 8 * 1024;
const MAX_EDIT_BYTES = 16 * 1024 * 1024;
const iso = (ms: number) => new Date(ms).toISOString();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  invariant(result.success, "INVALID_REQUEST", "Invalid folder tool arguments. Use the documented schema.", 400);
  return result.data!;
}

export type FolderEngineOptions = {
  stateDirectory: string;
  clock?: () => number;
  renderer?: { name: DeckRenderer; render: PdfRender };
};

/**
 * Owner-chosen folders on this Mac. A local human lease (never MCP, gateway or
 * phone) enables bounded list/read/search/text-write and deck creation. There
 * is no shell, no symlink following and no access outside the roots.
 */
export class FolderEngine implements FilesAgent {
  private lease?: { until: number; epoch: number };
  private epoch = 0;
  private artifacts = new Map<string, { sha256: string; bytes: number; epoch: number }>();
  private flight: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private stopping = false;
  private clock: () => number;
  private renderer: { name: DeckRenderer; render: PdfRender };
  readonly audit: FolderAudit;
  readonly backups: string;
  constructor(
    readonly store: Store,
    readonly roots: Root[],
    readonly options: FolderEngineOptions,
  ) {
    invariant(roots.length > 0, "FILES_DISABLED", "Configure at least one folder.", 400);
    this.clock = options.clock ?? Date.now;
    this.renderer = options.renderer ?? defaultRenderer();
    this.audit = new FolderAudit(options.stateDirectory);
    this.backups = join(options.stateDirectory, "backups");
    // Fail at startup if the private audit record cannot be kept.
    this.audit.ready();
    store.data.files ??= { writes: [] };
    for (const record of this.data.writes)
      if (record.state === "pending") record.state = "uncertain";
    store.save();
  }
  private get data() {
    return this.store.data.files!;
  }
  get outputFolder() {
    return join(this.roots[0].path, "Presentations");
  }
  status(): FolderStatus {
    const active = this.active();
    return structuredClone({
      enabled: true as const,
      authority: "here" as const,
      roots: this.roots,
      lease: { active, ...(this.lease ? { expiresAt: iso(this.lease.until) } : {}) },
      stateDirectory: this.options.stateDirectory,
      auditPath: this.audit.path,
      outputFolder: this.outputFolder,
      writes: this.data.writes.slice(-10).reverse().map(({ id, tool, at, mode, path, state }) => ({ id, tool, at, mode, path, state })),
    });
  }
  private active() {
    return !this.stopping && !!this.lease && this.lease.until > this.clock();
  }
  /** Local human route only. Folder access is never granted remotely. */
  grant() {
    invariant(!this.stopping, "FILES_STOPPING", "The companion is stopping.", 503);
    this.revoke();
    this.audit.ready();
    this.lease = { until: this.clock() + DEVICE_SESSION_MS, epoch: this.epoch };
    this.audit.record({ at: iso(this.clock()), tool: "lease.grant", code: "OK" });
    return this.status();
  }
  revoke() {
    const had = !!this.lease;
    this.epoch++;
    this.lease = undefined;
    this.artifacts.clear();
    if (had) this.audit.record({ at: iso(this.clock()), tool: "lease.revoke", code: "OK" });
    return this.status();
  }
  async shutdown() {
    this.stopping = true;
    this.revoke();
    await this.flight;
  }
  private allowed() {
    invariant(
      this.active(),
      "FOLDER_LEASE_REQUIRED",
      "Fo has no folder access now. On the Mac, open Fo Reach and choose 'Allow Fo for 3 hours'. Fo cannot grant this.",
      403,
    );
    return this.lease!;
  }
  private still(lease: { until: number; epoch: number }) {
    invariant(
      this.lease === lease && this.active(),
      "FOLDER_LEASE_CHANGED",
      "Folder access was revoked or expired during this operation.",
      403,
    );
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    invariant(this.queued < 16, "FILES_BUSY", "The bounded folder-tool queue is full.", 429);
    this.queued++;
    const next = this.flight.then(operation, operation).finally(() => {
      this.queued--;
    });
    this.flight = next.catch(() => {});
    return next;
  }
  private async call<T>(
    tool: string,
    path: string | undefined,
    operation: (note: (info: { path?: string; bytes?: number; count?: number }) => void) => Promise<T>,
  ) {
    const info: { path?: string; bytes?: number; count?: number } = path === undefined ? {} : { path };
    try {
      const result = await this.serial(() => operation((more) => Object.assign(info, more)));
      this.audit.record({ at: iso(this.clock()), tool, ...info, code: "OK" });
      return result;
    } catch (error) {
      this.audit.record({ at: iso(this.clock()), tool, ...info, code: error instanceof FixError ? error.code : "INTERNAL_ERROR" });
      throw error;
    }
  }
  private resolve(path: string, options?: { mustExist?: boolean }) {
    return resolvePath(this.roots, path, options);
  }
  private async readExact(path: string, limit: number) {
    const before = await lstat(path);
    invariant(!before.isSymbolicLink(), "FILES_SYMLINK", "Symlinks are not followed in allowed folders.", 403);
    invariant(before.isFile(), "FILES_NOT_FILE", "That path is not a regular file.", 400);
    invariant(before.nlink === 1, "FILES_HARD_LINK", "Files with several hard links are outside folder access.", 403);
    invariant(before.size <= limit, "FILES_TOO_LARGE", "That file is larger than this operation allows.", 413);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      invariant(stat.dev === before.dev && stat.ino === before.ino, "FILES_CHANGED", "The file changed while it was opened.", 409);
      const buffer = Buffer.alloc(Math.min(stat.size, limit) + 1);
      let length = 0;
      while (length < buffer.length) {
        const part = await handle.read(buffer, length, buffer.length - length, length);
        if (!part.bytesRead) break;
        length += part.bytesRead;
      }
      const after = await handle.stat();
      invariant(length === stat.size && after.size === stat.size && after.mtimeMs === stat.mtimeMs,
        "FILES_CHANGED", "The file changed while it was read. Try again.", 409);
      return { bytes: buffer.subarray(0, length), stat };
    } finally {
      await handle.close();
    }
  }
  private sameFile(a: Stats, b: Stats) {
    return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
  }

  async list(value: z.infer<typeof filesList>): Promise<FilesListResult> {
    const args = parse(filesList, value);
    return this.call("files.list", args.path, async (note) => {
      const lease = this.allowed();
      const target = await this.resolve(args.path, { mustExist: true });
      note({ path: target.absolute });
      invariant((await lstat(target.absolute)).isDirectory(), "FILES_NOT_DIRECTORY", "Use files.read for a file; files.list needs a folder.", 400);
      const depth = args.depth ?? 1;
      const entries: FilesListResult["entries"] = [];
      let hiddenSkipped = 0, truncated = false;
      const queue = [{ path: target.absolute, level: 1 }];
      walk: while (queue.length) {
        const directory = queue.shift()!;
        const names = (await readdir(directory.path)).sort();
        for (const name of names) {
          if (hiddenName(name)) { hiddenSkipped++; continue; }
          if (entries.length >= FILES_LIMITS.listEntries) { truncated = true; break walk; }
          const path = join(directory.path, name);
          let info: Stats;
          try { info = await lstat(path); } catch { continue; }
          const type = info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other";
          entries.push({ path, name, type, size: type === "file" ? info.size : 0, mtime: iso(info.mtimeMs) });
          if (type === "directory" && directory.level < depth) queue.push({ path, level: directory.level + 1 });
        }
      }
      this.still(lease);
      const result: FilesListResult = { root: target.root.path, path: target.absolute, depth, roots: this.roots, entries, truncated, hiddenSkipped };
      while (entries.length && mcpEncodedBytes(result) > RESULT_BUDGET) { entries.pop(); result.truncated = true; }
      note({ count: entries.length });
      return result;
    });
  }

  async read(value: z.infer<typeof filesRead>): Promise<FilesReadResult> {
    const args = parse(filesRead, value);
    return this.call("files.read", args.path, async (note) => {
      const lease = this.allowed();
      const target = await this.resolve(args.path, { mustExist: true });
      note({ path: target.absolute });
      const before = await lstat(target.absolute);
      invariant(before.isFile(), "FILES_NOT_FILE", "files.read needs a regular file; use files.list for folders.", 400);
      invariant(before.nlink === 1, "FILES_HARD_LINK", "Files with several hard links are outside folder access.", 403);
      invariant(!sharedExtensions.includes(extensionOf(target.absolute) as never), "FILES_BINARY", "That is a binary document, not UTF-8 text.", 415);
      const handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      let bytes: Buffer, stat: Stats;
      const requested = args.offset ?? 0, max = args.maxBytes ?? 128 * 1024;
      try {
        stat = await handle.stat();
        invariant(stat.dev === before.dev && stat.ino === before.ino, "FILES_CHANGED", "The file changed while it was opened.", 409);
        invariant(requested <= stat.size, "FILES_RANGE", "The offset is beyond the end of the file.", 400);
        const buffer = Buffer.alloc(Math.min(max, stat.size - requested));
        let length = 0;
        while (length < buffer.length) {
          const part = await handle.read(buffer, length, buffer.length - length, requested + length);
          if (!part.bytesRead) break;
          length += part.bytesRead;
        }
        bytes = buffer.subarray(0, length);
        const after = await handle.stat();
        invariant(after.size === stat.size && after.mtimeMs === stat.mtimeMs, "FILES_CHANGED", "The file changed while it was read. Try again.", 409);
      } finally {
        await handle.close();
      }
      // Align to UTF-8 character boundaries; never split a code point.
      let start = 0;
      while (requested > 0 && start < 3 && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      let end = bytes.length;
      if (requested + end < stat.size) {
        let lead = end - 1;
        while (lead > start && end - lead < 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
        const need = bytes[lead] >= 0xf0 ? 4 : bytes[lead] >= 0xe0 ? 3 : bytes[lead] >= 0xc0 ? 2 : 1;
        if (lead + need > end) end = lead;
      }
      const window = bytes.subarray(start, end);
      invariant(!window.includes(0), "FILES_BINARY", "That file contains binary data, not UTF-8 text.", 415);
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(window); }
      catch { throw new FixError("FILES_BINARY", "That file is not valid UTF-8 text.", 415); }
      const offset = requested + start;
      const build = (t: string): FilesReadResult => {
        const length = Buffer.byteLength(t);
        return { path: target.absolute, size: stat.size, mtime: iso(stat.mtimeMs), offset, nextOffset: offset + length, bytes: length, truncated: offset + length < stat.size, text: t };
      };
      let result = build(text);
      while (mcpEncodedBytes(result) > RESULT_BUDGET && text.length) {
        const excess = mcpEncodedBytes(result) - RESULT_BUDGET;
        let cut = Math.max(1, text.length - Math.ceil(excess / 2) - 64);
        if (/[\ud800-\udbff]/.test(text[cut - 1] ?? "")) cut--;
        text = text.slice(0, cut);
        result = build(text);
      }
      this.still(lease);
      note({ bytes: result.bytes });
      return result;
    });
  }

  async search(value: z.infer<typeof filesSearch>): Promise<FilesSearchResult> {
    const args = parse(filesSearch, value);
    return this.call("files.search", args.path, async (note) => {
      const lease = this.allowed();
      const limit = args.maxResults ?? 50, query = args.query.toLowerCase(), started = this.clock();
      const scopes: { path: string; level: number }[] = [];
      if (args.path !== undefined) {
        const target = await this.resolve(args.path, { mustExist: true });
        note({ path: target.absolute });
        scopes.push({ path: target.absolute, level: 0 });
      } else for (const root of this.roots) scopes.push({ path: root.path, level: 0 });
      const result: FilesSearchResult = { matches: [], truncated: false, filesScanned: 0, bytesScanned: 0, skipped: 0 };
      let visited = 0;
      const exhausted = () => {
        if (result.filesScanned >= FILES_LIMITS.searchFiles || result.bytesScanned >= FILES_LIMITS.searchTotalBytes ||
          visited > FILES_LIMITS.searchFiles * 10 || this.clock() - started > FILES_LIMITS.searchMs) {
          result.truncated = true;
          return true;
        }
        return false;
      };
      const stack = scopes.reverse();
      search: while (stack.length) {
        if (exhausted()) break;
        visited++;
        const item = stack.pop()!;
        let info: Stats;
        try { info = await lstat(item.path); } catch { continue; }
        if (info.isSymbolicLink()) { result.skipped++; continue; }
        if (info.isDirectory()) {
          if (item.level >= FILES_LIMITS.searchDepth) { result.skipped++; continue; }
          const names = (await readdir(item.path)).filter((n) => !hiddenName(n)).sort().reverse();
          for (const name of names) stack.push({ path: join(item.path, name), level: item.level + 1 });
          continue;
        }
        if (!info.isFile() || !textExtensions.includes(extensionOf(item.path) as never)) continue;
        if (info.size > FILES_LIMITS.searchFileBytes || info.nlink !== 1 || result.bytesScanned + info.size > FILES_LIMITS.searchTotalBytes) { result.skipped++; continue; }
        if (exhausted()) break;
        let bytes: Buffer;
        try { bytes = (await this.readExact(item.path, FILES_LIMITS.searchFileBytes)).bytes; }
        catch { result.skipped++; continue; }
        result.filesScanned++;
        result.bytesScanned += bytes.length;
        if (bytes.includes(0)) { result.skipped++; continue; }
        const lines = bytes.toString("utf8").split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i], at = line.toLowerCase().indexOf(query);
          if (at < 0) continue;
          if (result.matches.length >= limit) { result.truncated = true; break search; }
          const from = Math.max(0, Math.min(at - 80, line.length - FILES_LIMITS.snippetChars));
          let snippet = line.slice(from, from + FILES_LIMITS.snippetChars);
          if (/[\udc00-\udfff]/.test(snippet[0] ?? "")) snippet = snippet.slice(1);
          if (/[\ud800-\udbff]/.test(snippet.at(-1) ?? "")) snippet = snippet.slice(0, -1);
          result.matches.push({ path: item.path, line: i + 1, snippet: (from > 0 ? "…" : "") + snippet + (from + FILES_LIMITS.snippetChars < line.length ? "…" : "") });
        }
        if (exhausted()) break;
      }
      this.still(lease);
      while (result.matches.length && mcpEncodedBytes(result) > RESULT_BUDGET) { result.matches.pop(); result.truncated = true; }
      note({ bytes: result.bytesScanned, count: result.matches.length });
      return result;
    });
  }

  /** Create missing parent folders one by one, refusing any symlink. */
  private async parents(target: Resolved) {
    const created: string[] = [];
    let current = target.root.path;
    for (const part of target.parts.slice(0, -1)) {
      current = join(current, part);
      try {
        await lstat(current);
      } catch {
        invariant(created.length < 8, "FILES_PATH", "Create at most eight new folders at once.", 400);
        try {
          await mkdir(current, { mode: 0o755 });
          created.push(current);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const info = await lstat(current);
      invariant(info.isDirectory() && !info.isSymbolicLink(), "FILES_SYMLINK", "A parent folder is not a real directory.", 403);
    }
    return created;
  }
  private async backup(id: string, target: Resolved, bytes: Buffer) {
    this.audit.ready();
    const stamp = iso(this.clock()).replaceAll(":", "-");
    const directory = join(this.backups, `${stamp}-${id.slice(0, 8)}`, target.root.name, ...target.parts.slice(0, -1));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let current = this.options.stateDirectory;
    for (const part of directory.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      const info = await lstat(current);
      invariant(info.isDirectory() && !info.isSymbolicLink(), "FILES_STATE", "The backup folder must be a real private directory.", 500);
    }
    const path = join(directory, target.parts.at(-1)!);
    await this.writeNew(path, bytes, 0o600);
    invariant(sha256((await this.readExact(path, MAX_EDIT_BYTES)).bytes) === sha256(bytes), "FILES_BACKUP", "The backup copy could not be verified. Nothing was changed.", 500);
    return path;
  }
  private async writeNew(path: string, bytes: Uint8Array, mode: number) {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  /** Replace an unchanged file atomically from a hidden temp file in its folder. */
  private async replace(target: Resolved, expected: Stats, bytes: Uint8Array, lease: { until: number; epoch: number }, id: string) {
    const temp = join(dirname(target.absolute), `.fo-reach-${id}.tmp`);
    await this.writeNew(temp, bytes, expected.mode & 0o777);
    try {
      const again = await this.resolve(target.absolute, { mustExist: true });
      invariant(again.absolute === target.absolute, "FILES_CHANGED", "The path changed before the write.", 409);
      invariant(this.sameFile(await lstat(target.absolute), expected), "FILES_CHANGED", "The file changed before the write; nothing was replaced. Read it again.", 409);
      this.still(lease);
      await rename(temp, target.absolute);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
  private journal(record: WriteRecord) {
    this.data.writes.push(record);
    while (this.data.writes.length > FILES_LIMITS.journal) {
      const index = this.data.writes.findIndex((w) => w.state !== "pending");
      if (index < 0) break;
      this.data.writes.splice(index, 1);
    }
    this.store.save();
  }

  async write(value: z.infer<typeof filesWrite>): Promise<FilesWriteResult> {
    const args = parse(filesWrite, value);
    return this.call("files.write", args.path, async (note) => {
      const lease = this.allowed();
      const target = await this.resolve(args.path);
      note({ path: target.absolute });
      invariant(target.parts.length > 0, "FILES_PATH", "Name a file inside the folder.", 400);
      invariant(textExtensions.includes(extensionOf(target.absolute) as never), "FILES_TYPE", "Fo can write only .md, .txt, .csv and .json files.", 403);
      const content = Buffer.from(args.content, "utf8");
      const record: WriteRecord = { id: randomUUID(), tool: "files.write", at: iso(this.clock()), mode: args.mode, path: target.absolute, state: "pending", createdDirs: [] };
      // prepared: nothing changed yet; replaced: bytes may be on disk.
      let phase: "checking" | "prepared" | "replaced" = "checking";
      try {
        let result: Buffer;
        if (args.mode === "create") {
          invariant(!target.exists, "FILES_EXISTS", "A file already exists there. Use mode overwrite or append; a backup is kept.", 409);
          record.createdDirs = await this.parents(target);
          this.still(lease);
          this.journal(record);
          phase = "prepared";
          try {
            await this.writeNew(target.absolute, content, 0o644);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST")
              throw new FixError("FILES_EXISTS", "A file appeared there before the write; nothing was changed.", 409);
            phase = "replaced";
            throw error;
          }
          result = content;
        } else {
          invariant(target.exists, "FILES_NOT_FOUND", "No file exists there. Use mode create.", 404);
          const before = await this.readExact(target.absolute, MAX_EDIT_BYTES);
          result = args.mode === "overwrite" ? content : Buffer.concat([before.bytes, content]);
          invariant(result.length <= MAX_EDIT_BYTES, "FILES_TOO_LARGE", "The resulting file would exceed 16 MiB.", 413);
          record.previousSha256 = sha256(before.bytes);
          record.backupPath = await this.backup(record.id, target, before.bytes);
          this.still(lease);
          this.journal(record);
          phase = "prepared";
          // The rename is the only mutation; a refusal before it changes nothing.
          await this.replace(target, before.stat, result, lease, record.id);
        }
        phase = "replaced";
        // Detect (never follow) an ancestor swapped for a symlink during the write.
        await this.resolve(target.absolute, { mustExist: true });
        const written = await this.readExact(target.absolute, MAX_EDIT_BYTES);
        invariant(sha256(written.bytes) === sha256(result), "FILES_VERIFY", "The written file does not match the requested content.", 500);
        record.state = "written";
        record.sha256 = sha256(result);
        record.bytes = result.length;
        this.store.save();
        note({ bytes: content.length });
        return {
          writeId: record.id, path: target.absolute, mode: args.mode, bytes: result.length, contentBytes: content.length,
          sha256: record.sha256, created: args.mode === "create", ...(record.backupPath ? { backupPath: record.backupPath } : {}),
        };
      } catch (error) {
        if (phase === "checking") await this.removeEmpty(record.createdDirs);
        if (phase !== "checking" && record.state === "pending") {
          record.state = phase === "prepared" ? "failed" : "uncertain";
          if (record.state === "failed") await this.removeEmpty(record.createdDirs);
          this.store.save();
        }
        throw error;
      }
    });
  }
  private async removeEmpty(directories: string[]) {
    for (const directory of [...directories].reverse()) {
      try {
        const info = await lstat(directory);
        if (info.isDirectory() && !info.isSymbolicLink() && !(await readdir(directory)).length) await rmdir(directory);
      } catch { /* Keep any folder that now holds other files. */ }
    }
  }

  async undoWrite(value: z.infer<typeof filesUndo>): Promise<FilesUndoResult> {
    const args = parse(filesUndo, value);
    return this.call("files.undo_write", undefined, async (note) => {
      const lease = this.allowed();
      const record = this.data.writes.find((w) => w.id === args.writeId);
      invariant(record, "FILES_WRITE_UNKNOWN", "No write with that ID is recorded on this Mac.", 404);
      note({ path: record.path });
      invariant(record.state === "written" && record.sha256, "FILES_UNDO_UNAVAILABLE", "Only a completed write that has not been undone can be undone.", 409);
      const target = await this.resolve(record.path, { mustExist: true });
      const current = await this.readExact(target.absolute, 64 * 1024 * 1024);
      invariant(sha256(current.bytes) === record.sha256, "FILES_CHANGED_SINCE_WRITE", "The file changed after Fo wrote it, so undo was refused to protect newer edits.", 409);
      let result: FilesUndoResult;
      if (record.mode === "create") {
        this.still(lease);
        invariant(this.sameFile(await lstat(target.absolute), current.stat), "FILES_CHANGED_SINCE_WRITE", "The file changed during undo; nothing was removed.", 409);
        await unlink(target.absolute);
        await this.removeEmpty(record.createdDirs);
        this.artifacts.delete(target.absolute);
        result = { writeId: record.id, path: target.absolute, action: "deleted" };
      } else {
        invariant(record.backupPath && record.previousSha256, "FILES_UNDO_UNAVAILABLE", "This write has no backup.", 409);
        invariant(record.backupPath.startsWith(this.backups + sep), "FILES_BACKUP", "The backup is outside the Fo Reach backup folder.", 500);
        const backup = await this.readExact(record.backupPath, MAX_EDIT_BYTES);
        invariant(sha256(backup.bytes) === record.previousSha256, "FILES_BACKUP_CHANGED", "The backup copy changed, so it was not restored.", 409);
        await this.replace(target, current.stat, backup.bytes, lease, randomUUID());
        const restored = await this.readExact(target.absolute, MAX_EDIT_BYTES);
        invariant(sha256(restored.bytes) === record.previousSha256, "FILES_VERIFY", "The restored file does not match its backup.", 500);
        result = { writeId: record.id, path: target.absolute, action: "restored", sha256: record.previousSha256 };
      }
      record.state = "undone";
      record.undoneAt = iso(this.clock());
      this.store.save();
      return result;
    });
  }

  async createSlides(value: SlidesCreate): Promise<SlidesResult> {
    const deck = parse(slidesCreate, value);
    return this.call("slides.create", deck.folder, async (note) => {
      const lease = this.allowed();
      const folder = await this.resolve(deck.folder ?? join(this.roots[0].path, "Presentations"));
      if (folder.exists) invariant((await lstat(folder.absolute)).isDirectory(), "FILES_NOT_DIRECTORY", "The output folder is not a folder.", 400);
      const pptx = buildPptx(deck, new Date(this.clock()));
      verifyPptx(pptx, deck);
      const pdf = await this.renderer.render(pptx, deck, AbortSignal.timeout(30_000));
      const pages = await pdfPageCount(pdf);
      invariant(pages === deck.slides.length, "SLIDES_PAGE_COUNT", `The PDF has ${pages} pages but the deck has ${deck.slides.length} slides. Nothing was saved.`, 502);
      invariant(pptx.length <= 32 * 1024 * 1024 && pdf.length <= 32 * 1024 * 1024, "SLIDES_TOO_LARGE", "The generated deck is unexpectedly large.", 413);
      this.still(lease);
      let stem = "";
      for (let i = 1; i <= 50 && !stem; i++) {
        const candidate = i === 1 ? deck.fileName : `${deck.fileName} (${i})`;
        const taken = await Promise.all([".pptx", ".pdf"].map((ext) => lstat(join(folder.absolute, candidate + ext)).then(() => true, () => false)));
        if (!taken.some(Boolean)) stem = candidate;
      }
      invariant(stem, "FILES_EXISTS", "Too many presentations already use that name. Choose another fileName.", 409);
      const pptxTarget = await this.resolve(join(folder.absolute, `${stem}.pptx`));
      const pdfTarget = await this.resolve(join(folder.absolute, `${stem}.pdf`));
      const createdDirs = await this.parents(pptxTarget);
      const records = [pptxTarget, pdfTarget].map((target, i): WriteRecord => ({
        id: randomUUID(), tool: "slides.create", at: iso(this.clock()), mode: "create", path: target.absolute, state: "pending", createdDirs: i === 0 ? createdDirs : [],
      }));
      this.still(lease);
      for (const record of records) this.journal(record);
      const files = [[pptxTarget, pptx], [pdfTarget, pdf]] as const;
      const written: string[] = [];
      try {
        for (const [target, bytes] of files) {
          await this.writeNew(target.absolute, bytes, 0o644);
          written.push(target.absolute);
        }
        files.forEach(([target, bytes], i) => {
          records[i].state = "written";
          records[i].sha256 = sha256(bytes);
          records[i].bytes = bytes.length;
        });
        for (const [target, bytes] of files) {
          await this.resolve(target.absolute, { mustExist: true });
          invariant(sha256((await this.readExact(target.absolute, 32 * 1024 * 1024)).bytes) === sha256(bytes), "FILES_VERIFY", "A saved deck file does not match the generated bytes.", 500);
        }
      } catch (error) {
        // Remove only files this call created; never leave half a deck behind.
        const remaining: string[] = [];
        for (const path of written) await unlink(path).catch(() => remaining.push(path));
        for (const record of records) record.state = remaining.includes(record.path) ? "uncertain" : "failed";
        if (!remaining.length) await this.removeEmpty(createdDirs);
        this.store.save();
        throw error;
      }
      this.store.save();
      for (const [target, bytes] of files) this.artifacts.set(target.absolute, { sha256: sha256(bytes), bytes: bytes.length, epoch: lease.epoch });
      note({ path: pptxTarget.absolute, bytes: pptx.length + pdf.length, count: deck.slides.length });
      const describe = (i: number) => ({ path: records[i].path, bytes: records[i].bytes!, sha256: records[i].sha256!, writeId: records[i].id });
      return { title: deck.title, slideCount: deck.slides.length, pageCount: pages, renderer: this.renderer.name, pptx: describe(0), pdf: describe(1) };
    });
  }

  async readArtifact(value: z.infer<typeof artifactRead>): Promise<ArtifactChunk> {
    const args = parse(artifactRead, value);
    return this.call("files.read_artifact", args.path, async (note) => {
      const lease = this.allowed();
      const target = await this.resolve(args.path, { mustExist: true });
      note({ path: target.absolute });
      const artifact = this.artifacts.get(target.absolute);
      invariant(artifact && artifact.epoch === lease.epoch && sharedExtensions.includes(extensionOf(target.absolute) as never),
        "FILES_SHARE_UNAVAILABLE", "Only .pptx or .pdf files created by slides.create during the current folder access can be shared.", 403);
      invariant(artifact.bytes <= FILES_LIMITS.shareBytes, "FILES_TOO_LARGE", "Shared files are limited to 10 MiB.", 413);
      const { bytes } = await this.readExact(target.absolute, FILES_LIMITS.shareBytes);
      invariant(sha256(bytes) === artifact.sha256, "FILES_CHANGED_SINCE_WRITE", "The deck changed after it was created, so it was not shared.", 409);
      invariant(args.offset < bytes.length, "FILES_RANGE", "Use 128 KiB chunk offsets inside the file.", 400);
      this.still(lease);
      const nextOffset = Math.min(args.offset + FILES_LIMITS.artifactChunk, bytes.length);
      note({ bytes: nextOffset - args.offset });
      return { path: target.absolute, name: basename(target.absolute), sha256: artifact.sha256, totalBytes: bytes.length, offset: args.offset, nextOffset, base64: bytes.subarray(args.offset, nextOffset).toString("base64") };
    });
  }
}

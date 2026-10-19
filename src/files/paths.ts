import { lstatSync, realpathSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { FixError, invariant } from "../core/errors.ts";
import { FILES_LIMITS } from "./contracts.ts";

export type Root = { name: string; path: string };
export type Resolved = { root: Root; relative: string; absolute: string; parts: string[] };

const inside = (parent: string, child: string) =>
  child === parent || child.startsWith(parent === sep ? sep : parent + sep);

/**
 * Validate owner-chosen folders once at startup. Folders come only from the
 * local command line or environment, never from Fo, MCP or the gateway.
 */
export function configureRoots(
  requested: string[],
  options: { home: string; stateDirectory: string },
): Root[] {
  const roots: Root[] = [];
  const fail = (message: string): never => {
    throw new FixError("FOLDER_CONFIGURATION", message, 400);
  };
  if (requested.length > FILES_LIMITS.roots) fail(`Allow at most ${FILES_LIMITS.roots} folders.`);
  for (const raw of requested) {
    if (!raw || !isAbsolute(raw) || /[\u0000-\u001f\u007f]/.test(raw))
      fail("Use an absolute folder path for each --allow-folder entry.");
    const path = resolve(raw);
    let canonical = "";
    try {
      // Reject symlinks in every ancestor, including the folder itself.
      let current: string = sep;
      for (const part of path.split(sep).filter(Boolean)) {
        current = join(current, part);
        const info = lstatSync(current);
        if (info.isSymbolicLink()) fail(`Allowed folders cannot contain symlinks: ${current}. Use the real folder path.`);
        if (!info.isDirectory()) fail(`Allowed folder is not a directory: ${current}.`);
      }
      canonical = realpathSync.native(path);
    } catch (error) {
      if (error instanceof FixError) throw error;
      fail(`Allowed folder does not exist or is unreadable: ${path}.`);
    }
    if (canonical !== path) fail(`Use the canonical folder path: ${canonical}.`);
    if (path === sep || path === resolve(options.home) || inside(path, resolve(options.home)))
      fail("Allow a specific folder, not the whole disk or home directory.");
    const state = resolve(options.stateDirectory);
    if (inside(path, state) || inside(state, path))
      fail("An allowed folder cannot contain or be inside the Fo Reach state directory.");
    for (const other of roots)
      if (inside(other.path, path) || inside(path, other.path)) fail("Allowed folders cannot overlap.");
    const base = basename(path);
    const taken = new Set(roots.map((r) => r.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
    roots.push({ name, path });
  }
  return roots;
}

export function folderArguments(argv: string[], env: NodeJS.ProcessEnv) {
  const folders: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow-folder") {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new FixError("FOLDER_CONFIGURATION", "--allow-folder needs a folder path.", 400);
      folders.push(value);
    } else if (arg.startsWith("--allow-folder=")) folders.push(arg.slice("--allow-folder=".length));
  }
  // Newline-separated so folder names may contain ':' or spaces.
  for (const value of (env.FO_FIX_ALLOWED_FOLDERS ?? "").split("\n"))
    if (value.trim()) folders.push(value.trim());
  return [...new Set(folders)];
}

/** Hidden names (.obsidian, .git, .DS_Store, our temp files) are never touched. */
export const hiddenName = (name: string) => name.startsWith(".");

function plainParts(input: string) {
  invariant(
    !input.includes("\\") && !/[\u0000-\u001f\u007f]/.test(input),
    "FILES_PATH",
    "Use a plain '/'-separated path.",
    400,
  );
  const parts = input.split("/").filter((p) => p && p !== ".");
  invariant(!parts.includes(".."), "FILES_PATH", "Paths cannot contain '..'.", 400);
  return parts;
}
function components(input: string) {
  const parts = plainParts(input);
  invariant(
    !parts.some(hiddenName),
    "FILES_HIDDEN",
    "Hidden files and folders (such as .obsidian or .git) are outside folder access.",
    403,
  );
  invariant(parts.every((p) => Buffer.byteLength(p) <= 255), "FILES_PATH", "A path component is too long.", 400);
  return parts;
}

/**
 * Map a relative path (against the first root) or an absolute path (inside
 * one root) to a canonical location. Every existing ancestor is checked with
 * lstat; symlinks are refused everywhere, including at the target itself.
 */
export async function resolvePath(
  roots: Root[],
  input: string,
  options: { mustExist?: boolean } = {},
): Promise<Resolved & { exists: boolean }> {
  invariant(roots.length > 0, "FILES_DISABLED", "No folders are configured on this Mac.", 404);
  let root: Root | undefined, rest: string;
  if (isAbsolute(input)) {
    const absolute = sep + plainParts(input).join(sep);
    root = roots.find((r) => inside(r.path, absolute));
    invariant(root, "FILES_OUTSIDE_ROOT", "That path is outside the folders allowed on this Mac.", 403);
    rest = absolute.slice(root.path.length);
  } else {
    root = roots[0];
    rest = input;
  }
  const parts = components(rest);
  const absolute = parts.length ? join(root.path, ...parts) : root.path;
  invariant(inside(root.path, absolute), "FILES_OUTSIDE_ROOT", "That path is outside the folders allowed on this Mac.", 403);
  let current: string = sep, existing: string = sep, exists = true;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      exists = false;
      break;
    }
    invariant(!info.isSymbolicLink(), "FILES_SYMLINK", "Symlinks are not followed in allowed folders.", 403);
    if (current !== absolute)
      invariant(info.isDirectory(), "FILES_PATH", "A path ancestor is not a directory.", 400);
    existing = current;
  }
  invariant(exists || !options.mustExist, "FILES_NOT_FOUND", "No file or folder exists at that path.", 404);
  // macOS folders ignore case; keep one exact spelling for journal and undo.
  invariant((await realpath(existing)) === existing, "FILES_PATH", "Use the exact path as files.list shows it; letter case and accents must match.", 409);
  return { root, relative: parts.join("/"), absolute, parts, exists };
}

export function extensionOf(path: string) {
  const name = basename(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

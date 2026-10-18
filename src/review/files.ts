import { constants } from "node:fs";
import { open, lstat, realpath } from "node:fs/promises";
import { resolve, join, relative, sep, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { invariant } from "../core/errors.ts";

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export async function safePath(root: string, name = "") {
  invariant(
    isAbsolute(root) && resolve(root) === root,
    "REVIEW_SCOPE",
    "Use an explicit canonical review root.",
  );
  const target = resolve(root, name);
  invariant(
    target === root || target.startsWith(root + sep),
    "REVIEW_PATH",
    "The requested file is outside the approved scope.",
  );
  invariant(
    !name ||
      (!isAbsolute(name) &&
        !name.split(/[\\/]/).some((p) => p === ".." || p === "." || !p)),
    "REVIEW_PATH",
    "Use exact scoped relative file names.",
  );
  // Inspect every ancestor, including ancestors of the configured root.
  const parts = target.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current);
    invariant(
      !info.isSymbolicLink(),
      "REVIEW_SYMLINK",
      "Symlinks are not allowed in review paths.",
    );
    if (current !== target)
      invariant(
        info.isDirectory(),
        "REVIEW_PATH",
        "A review path ancestor is not a directory.",
      );
  }
  invariant(
    (await realpath(target)) === target,
    "REVIEW_PATH",
    "The review path changed.",
  );
  return target;
}
export async function safeRead(
  root: string,
  name: string,
  limit = 4 * 1024 * 1024,
) {
  const path = await safePath(root, name);
  const before = await lstat(path);
  invariant(
    before.isFile() && before.nlink === 1 && before.size <= limit,
    "REVIEW_FILE",
    "Only bounded regular files with one link are supported.",
  );
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    invariant(
      info.dev === before.dev && info.ino === before.ino && info.size <= limit,
      "REVIEW_CHANGED",
      "A source changed during inspection.",
    );
    const bounded = Buffer.alloc(Math.min(info.size + 1, limit + 1));
    let length = 0;
    while (length < bounded.length) {
      const part = await file.read(
        bounded,
        length,
        bounded.length - length,
        null,
      );
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const bytes = bounded.subarray(0, length);
    const after = await file.stat();
    invariant(
      bytes.length <= limit &&
        info.size === after.size &&
        info.mtimeMs === after.mtimeMs &&
        info.ctimeMs === after.ctimeMs,
      "REVIEW_CHANGED",
      "A source changed during inspection.",
    );
    invariant(
      (await safePath(root, name)) === path,
      "REVIEW_CHANGED",
      "The source path changed.",
    );
    const final = await lstat(path);
    invariant(
      final.ino === info.ino && final.dev === info.dev,
      "REVIEW_CHANGED",
      "The source identity changed.",
    );
    return bytes;
  } finally {
    await file.close();
  }
}
export function localName(root: string, path: string) {
  const name = relative(root, path);
  invariant(
    name && !name.startsWith("..") && !isAbsolute(name),
    "REVIEW_PATH",
    "The output must remain in its approved scope.",
  );
  return name;
}

import { constants } from "node:fs";
import { open, lstat, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { invariant } from "../core/errors.ts";
import { safePath } from "./files.ts";

export type OutputBoundary = () => Promise<void>;
export class OutputDirectory {
  private constructor(
    readonly directory: string,
    private handle: FileHandle,
    private boundary: OutputBoundary,
  ) {}
  static async open(directory: string, boundary: OutputBoundary) {
    invariant(
      typeof boundary === "function",
      "REVIEW_OUTPUT",
      "An engine-bound output scope is required.",
    );
    await boundary();
    await safePath(directory);
    const handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const output = new OutputDirectory(directory, handle, boundary);
    try {
      await output.check();
      return output;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  async check() {
    await this.boundary();
    await safePath(this.directory);
    const opened = await this.handle.stat(),
      current = await lstat(this.directory);
    invariant(
      opened.isDirectory() &&
        current.dev === opened.dev &&
        current.ino === opened.ino,
      "REVIEW_OUTPUT_CHANGED",
      "The approved output directory changed. No new output write is allowed.",
    );
    await this.boundary();
  }
  async identity() {
    await this.check();
    const directory = await this.handle.stat(),
      parent = await lstat(dirname(this.directory));
    return {
      directoryDevice: directory.dev,
      directoryInode: directory.ino,
      parentDevice: parent.dev,
      parentInode: parent.ino,
    };
  }
  async write(name: string, bytes: Uint8Array | string) {
    invariant(
      /^(review\.(pdf|html|json|pptx)|page-[123]\.png|template\.key|before\.png|proposed\.png|request\.json|receipt\.json)$/.test(
        name,
      ),
      "REVIEW_OUTPUT",
      "Unsupported fixed output name.",
    );
    await this.check();
    // Linux writes stay anchored to the already-open directory even if an
    // ancestor changes between checks. Never follow an output leaf symlink.
    const path =
      process.platform === "linux"
        ? `/proc/self/fd/${this.handle.fd}/${name}`
        : join(this.directory, name);
    const file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await this.check();
      const opened = await file.stat(),
        named = await lstat(join(this.directory, name));
      invariant(
        opened.isFile() &&
          opened.nlink === 1 &&
          named.dev === opened.dev &&
          named.ino === opened.ino,
        "REVIEW_OUTPUT_CHANGED",
        "The generated file changed before its write.",
      );
      await file.writeFile(bytes);
      await this.check();
    } finally {
      await file.close();
    }
  }
  close() {
    return this.handle.close();
  }
}

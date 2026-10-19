import { appendFileSync, chmodSync, constants, lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { invariant } from "../core/errors.ts";

export type AuditLine = {
  at: string;
  tool: string;
  path?: string;
  bytes?: number;
  count?: number;
  code: string;
};

/**
 * Append-only JSONL tool-call record: tool, path, byte count and result code.
 * No file contents, search queries, notes or slide text are ever written.
 */
export class FolderAudit {
  readonly path: string;
  constructor(readonly directory: string) {
    this.path = join(directory, "audit.jsonl");
  }
  /** Fail closed at grant time if the record cannot be kept. */
  ready() {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(this.directory);
    invariant(
      info.isDirectory() && !info.isSymbolicLink(),
      "FILES_STATE",
      "The Fo Reach state directory must be a real private directory.",
      500,
    );
    chmodSync(this.directory, 0o700);
    const fd = openSync(
      this.path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    chmodSync(this.path, 0o600);
  }
  record(line: AuditLine) {
    try {
      const fd = openSync(this.path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try {
        appendFileSync(fd, JSON.stringify(line) + "\n");
      } finally {
        closeSync(fd);
      }
    } catch {
      /* Audit failures never echo file data; grant() checks writability. */
    }
  }
}

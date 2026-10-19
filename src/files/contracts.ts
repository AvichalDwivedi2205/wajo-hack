import { z } from "zod";

// Folder tools: owner-chosen roots on the Mac, a local three-hour lease and no
// shell. Every argument and relayed result is strict and bounded.
export const FILES_LIMITS = {
  pathChars: 1024,
  listEntries: 500,
  listDepth: 3,
  readBytes: 256 * 1024,
  writeBytes: 512 * 1024,
  // JSON escaping of control-heavy text must still fit relay/MCP bodies.
  writeJsonBytes: 768 * 1024,
  searchResults: 100,
  searchQueryChars: 200,
  searchFiles: 5000,
  searchFileBytes: 2 * 1024 * 1024,
  searchTotalBytes: 64 * 1024 * 1024,
  searchMs: 8000,
  searchDepth: 12,
  snippetChars: 240,
  shareBytes: 10 * 1024 * 1024,
  artifactChunk: 128 * 1024,
  journal: 500,
  roots: 8,
} as const;
export const textExtensions = [".md", ".txt", ".csv", ".json"] as const;
export const sharedExtensions = [".pptx", ".pdf"] as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
// String.prototype.isWellFormed is ES2024; keep the ES2023 target.
export const wellFormed = (s: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
// No NUL, no newline/control characters and well-formed UTF-16 so that a path
// cannot smuggle terminal or protocol framing into audit or tool results.
export const filePath = z
  .string()
  .max(FILES_LIMITS.pathChars)
  .refine((p) => !/[\u0000-\u001f\u007f]/.test(p) && wellFormed(p), "Use a plain path without control characters.");
const outPath = z.string().min(1).max(4096);
const isoTime = z.iso.datetime();

export const filesList = z
  .object({ path: filePath, depth: z.number().int().min(1).max(FILES_LIMITS.listDepth).optional() })
  .strict();
export const filesRead = z
  .object({
    path: filePath.min(1),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    maxBytes: z.number().int().min(1).max(FILES_LIMITS.readBytes).optional(),
  })
  .strict();
export const filesSearch = z
  .object({
    query: z
      .string()
      .min(1)
      .max(FILES_LIMITS.searchQueryChars)
      .refine((q) => q.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(q) && wellFormed(q), "Use a single-line text query."),
    path: filePath.optional(),
    maxResults: z.number().int().min(1).max(FILES_LIMITS.searchResults).optional(),
  })
  .strict();
export const filesWrite = z
  .object({
    path: filePath.min(1),
    content: z
      .string()
      .refine((c) => Buffer.byteLength(c) <= FILES_LIMITS.writeBytes, "Content is limited to 512 KiB of UTF-8.")
      .refine((c) => !c.includes("\u0000") && wellFormed(c), "Content must be text without NUL characters.")
      .refine((c) => Buffer.byteLength(JSON.stringify(c)) <= FILES_LIMITS.writeJsonBytes, "Content has too many escaped control characters."),
    mode: z.enum(["create", "overwrite", "append"]),
  })
  .strict();
export const filesUndo = z.object({ writeId: z.uuid() }).strict();
export const filesShare = z.object({ path: filePath.min(1) }).strict();
export const artifactRead = z
  .object({
    path: filePath.min(1),
    offset: z.number().int().min(0).max(FILES_LIMITS.shareBytes).multipleOf(FILES_LIMITS.artifactChunk),
  })
  .strict();

const slideText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => s.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(s) && wellFormed(s), "Use single-line visible text.");
export const slideSpec = z
  .object({
    title: slideText(120),
    bullets: z.array(slideText(200)).max(6).optional(),
    stats: z
      .array(z.object({ value: slideText(16), label: slideText(48) }).strict())
      .max(3)
      .optional(),
    note: z
      .string()
      .min(1)
      .max(1000)
      .refine((s) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s) && wellFormed(s), "Notes may use line breaks but no other control characters.")
      .optional(),
  })
  .strict();
export type SlideSpec = z.infer<typeof slideSpec>;
export const slidesCreate = z
  .object({
    title: slideText(120),
    slides: z.array(slideSpec).min(2).max(10),
    // A plain file stem; the tool adds .pptx and .pdf and never overwrites.
    fileName: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} _().,'&+-]*$/u, "Use letters, numbers, spaces and simple punctuation for the file name.")
      .refine((n) => !n.includes("..") && wellFormed(n), "Use a simple file name."),
    folder: filePath.optional(),
  })
  .strict();
export type SlidesCreate = z.infer<typeof slidesCreate>;

export const rootInfo = z.object({ name: z.string().min(1).max(255), path: outPath }).strict();
export const listEntry = z
  .object({
    path: outPath,
    name: z.string().min(1).max(255),
    type: z.enum(["file", "directory", "symlink", "other"]),
    size: z.number().int().min(0),
    mtime: isoTime,
  })
  .strict();
export const filesListResult = z
  .object({
    root: outPath,
    path: outPath,
    depth: z.number().int().min(1).max(FILES_LIMITS.listDepth),
    roots: z.array(rootInfo).min(1).max(FILES_LIMITS.roots),
    entries: z.array(listEntry).max(FILES_LIMITS.listEntries),
    truncated: z.boolean(),
    hiddenSkipped: z.number().int().min(0),
  })
  .strict();
export const filesReadResult = z
  .object({
    path: outPath,
    size: z.number().int().min(0),
    mtime: isoTime,
    offset: z.number().int().min(0),
    nextOffset: z.number().int().min(0),
    bytes: z.number().int().min(0).max(FILES_LIMITS.readBytes),
    truncated: z.boolean(),
    text: z.string().max(FILES_LIMITS.readBytes),
  })
  .strict()
  .refine(
    (r) => Buffer.byteLength(r.text) === r.bytes && r.nextOffset === r.offset + r.bytes && r.nextOffset <= r.size && r.truncated === r.nextOffset < r.size,
    "Read evidence must describe one consistent byte range.",
  );
export const searchMatch = z
  .object({ path: outPath, line: z.number().int().min(1), snippet: z.string().max(FILES_LIMITS.snippetChars + 8) })
  .strict();
export const filesSearchResult = z
  .object({
    matches: z.array(searchMatch).max(FILES_LIMITS.searchResults),
    truncated: z.boolean(),
    filesScanned: z.number().int().min(0).max(FILES_LIMITS.searchFiles),
    bytesScanned: z.number().int().min(0).max(FILES_LIMITS.searchTotalBytes),
    skipped: z.number().int().min(0),
  })
  .strict();
export const filesWriteResult = z
  .object({
    writeId: z.uuid(),
    path: outPath,
    mode: z.enum(["create", "overwrite", "append"]),
    bytes: z.number().int().min(0),
    contentBytes: z.number().int().min(0).max(FILES_LIMITS.writeBytes),
    sha256,
    created: z.boolean(),
    backupPath: outPath.optional(),
  })
  .strict()
  .refine((r) => (r.mode === "create") === r.created && (r.mode === "create") === !r.backupPath, "Only overwrite and append have a backup.");
export const filesUndoResult = z
  .object({ writeId: z.uuid(), path: outPath, action: z.enum(["deleted", "restored"]), sha256: sha256.optional() })
  .strict()
  .refine((r) => (r.action === "restored") === !!r.sha256, "A restored file reports its hash.");
export const artifactChunk = z
  .object({
    path: outPath,
    name: z.string().min(1).max(255).regex(/\.(pptx|pdf)$/),
    sha256,
    totalBytes: z.number().int().positive().max(FILES_LIMITS.shareBytes),
    offset: z.number().int().min(0).multipleOf(FILES_LIMITS.artifactChunk),
    nextOffset: z.number().int().positive(),
    base64: z
      .string()
      .min(4)
      .max(Math.ceil(FILES_LIMITS.artifactChunk / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
export type ArtifactChunk = z.infer<typeof artifactChunk>;
const deckFile = z
  .object({ path: outPath, bytes: z.number().int().positive().max(FILES_LIMITS.shareBytes * 4), sha256, writeId: z.uuid() })
  .strict();
export const slidesResult = z
  .object({
    title: z.string().max(120),
    slideCount: z.number().int().min(2).max(10),
    pageCount: z.number().int().min(2).max(10),
    renderer: z.enum(["macos-quick-look+chrome", "pdf-lib"]),
    pptx: deckFile,
    pdf: deckFile,
  })
  .strict()
  .refine((r) => r.slideCount === r.pageCount && r.pptx.path.endsWith(".pptx") && r.pdf.path.endsWith(".pdf"), "Deck evidence must match its PDF pages.");

export type FilesListResult = z.infer<typeof filesListResult>;
export type FilesReadResult = z.infer<typeof filesReadResult>;
export type FilesSearchResult = z.infer<typeof filesSearchResult>;
export type FilesWriteResult = z.infer<typeof filesWriteResult>;
export type FilesUndoResult = z.infer<typeof filesUndoResult>;
export type SlidesResult = z.infer<typeof slidesResult>;

export interface FilesAgent {
  list(args: z.infer<typeof filesList>): Promise<FilesListResult>;
  read(args: z.infer<typeof filesRead>): Promise<FilesReadResult>;
  search(args: z.infer<typeof filesSearch>): Promise<FilesSearchResult>;
  write(args: z.infer<typeof filesWrite>): Promise<FilesWriteResult>;
  undoWrite(args: z.infer<typeof filesUndo>): Promise<FilesUndoResult>;
  createSlides(args: SlidesCreate): Promise<SlidesResult>;
  readArtifact(args: z.infer<typeof artifactRead>): Promise<ArtifactChunk>;
}

export type WriteRecord = {
  id: string;
  tool: "files.write" | "slides.create";
  at: string;
  mode: "create" | "overwrite" | "append";
  path: string;
  // failed: refused before any change; uncertain: may be partially applied.
  state: "pending" | "written" | "failed" | "uncertain" | "undone";
  sha256?: string;
  bytes?: number;
  previousSha256?: string;
  backupPath?: string;
  createdDirs: string[];
  undoneAt?: string;
};
export type FolderStatus = {
  enabled: true;
  authority: "here";
  roots: z.infer<typeof rootInfo>[];
  lease: { active: boolean; expiresAt?: string };
  stateDirectory: string;
  auditPath: string;
  outputFolder: string;
  writes: Pick<WriteRecord, "id" | "tool" | "at" | "mode" | "path" | "state">[];
};

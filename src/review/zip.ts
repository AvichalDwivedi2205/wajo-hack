import { inflateRawSync, crc32 } from "node:zlib";
import { invariant } from "../core/errors.ts";

// Read only a narrow ZIP subset. Metadata sizes alone are not expansion limits:
// zlib enforces actual output bytes, then length and CRC must match both headers.
export function boundedZip(
  buffer: Uint8Array,
  limits: {
    entries: number;
    total: number;
    entry: number;
    allowed: (name: string) => boolean;
  },
) {
  const bytes = Buffer.from(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  );
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  invariant(
    end >= 0 &&
      bytes.readUInt16LE(end + 4) === 0 &&
      bytes.readUInt16LE(end + 6) === 0,
    "REVIEW_ZIP",
    "Unsupported ZIP structure.",
  );
  const count = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12),
    start = bytes.readUInt32LE(end + 16);
  invariant(
    count > 0 &&
      count <= limits.entries &&
      count === bytes.readUInt16LE(end + 8) &&
      start + size === end,
    "REVIEW_ZIP",
    "Unsupported ZIP directory or entry count.",
  );
  let cursor = start,
    total = 0;
  const output: Record<string, Uint8Array> = Object.create(null),
    ranges: Array<[number, number]> = [];
  for (let index = 0; index < count; index++) {
    invariant(
      cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50,
      "REVIEW_ZIP",
      "Invalid ZIP entry.",
    );
    const flags = bytes.readUInt16LE(cursor + 8),
      method = bytes.readUInt16LE(cursor + 10),
      crc = bytes.readUInt32LE(cursor + 16),
      compressed = bytes.readUInt32LE(cursor + 20),
      declared = bytes.readUInt32LE(cursor + 24),
      nameLength = bytes.readUInt16LE(cursor + 28),
      extra = bytes.readUInt16LE(cursor + 30),
      comment = bytes.readUInt16LE(cursor + 32),
      offset = bytes.readUInt32LE(cursor + 42);
    invariant(
      cursor + 46 + nameLength + extra + comment <= end &&
        nameLength > 0 &&
        nameLength <= 256 &&
        !(flags & ~0x808) &&
        [0, 8].includes(method) &&
        declared <= limits.entry &&
        total + declared <= limits.total,
      "REVIEW_ZIP_LIMIT",
      "Unsupported or excessive ZIP entry.",
    );
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      name = nameBytes.toString("utf8");
    const components = (name.endsWith("/") ? name.slice(0, -1) : name).split(
      "/",
    );
    invariant(
      Buffer.from(name, "utf8").equals(nameBytes) &&
        !Object.hasOwn(output, name) &&
        !name.startsWith("/") &&
        !name.includes("\\") &&
        components.every(
          (part) => part !== ".." && part !== "." && part.length > 0,
        ) &&
        limits.allowed(name),
      "REVIEW_ZIP",
      "Unsupported or ambiguous archive path.",
    );
    invariant(
      offset + 30 <= start &&
        bytes.readUInt32LE(offset) === 0x04034b50 &&
        bytes.readUInt16LE(offset + 6) === flags &&
        bytes.readUInt16LE(offset + 8) === method,
      "REVIEW_ZIP",
      "ZIP local and central headers differ.",
    );
    const localName = bytes.readUInt16LE(offset + 26),
      localExtra = bytes.readUInt16LE(offset + 28),
      data = offset + 30 + localName + localExtra;
    invariant(
      localName === nameLength &&
        bytes
          .subarray(offset + 30, offset + 30 + localName)
          .equals(nameBytes) &&
        data + compressed <= start &&
        !ranges.some(([a, b]) => offset < b && data + compressed > a),
      "REVIEW_ZIP",
      "Overlapping ZIP entries or names.",
    );
    if (!(flags & 8))
      invariant(
        bytes.readUInt32LE(offset + 18) === compressed &&
          bytes.readUInt32LE(offset + 22) === declared &&
          bytes.readUInt32LE(offset + 14) === crc,
        "REVIEW_ZIP",
        "ZIP header lengths differ.",
      );
    const compressedBytes = bytes.subarray(data, data + compressed);
    const result =
      method === 0
        ? compressedBytes
        : inflateRawSync(compressedBytes, {
            maxOutputLength: Math.min(limits.entry, limits.total - total) + 1,
          });
    invariant(
      result.length === declared &&
        (!name.endsWith("/") || result.length === 0) &&
        result.length <= limits.entry &&
        total + result.length <= limits.total &&
        crc32(result) === crc,
      "REVIEW_ZIP_LIMIT",
      "ZIP actual expansion, checksum or declared size is invalid.",
    );
    output[name] = result;
    total += result.length;
    ranges.push([offset, data + compressed]);
    cursor += 46 + nameLength + extra + comment;
  }
  invariant(cursor === end, "REVIEW_ZIP", "Unexpected ZIP directory data.");
  return output;
}

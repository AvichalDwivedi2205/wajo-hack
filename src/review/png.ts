import { crc32, inflateSync } from "node:zlib";
import { invariant } from "../core/errors.ts";

export function validatePng(bytes: Buffer) {
  invariant(
    bytes.length >= 33 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "REVIEW_IMAGE",
    "Expected a bounded plain PNG screenshot.",
  );
  let cursor = 8,
    chunks = 0,
    width = 0,
    height = 0,
    channels = 0,
    ended = false,
    dataEnded = false;
  const data: Buffer[] = [];
  while (cursor + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(cursor),
      type = bytes.toString("latin1", cursor + 4, cursor + 8);
    invariant(
      /^[A-Za-z]{4}$/.test(type),
      "REVIEW_IMAGE",
      "PNG chunk types must be literal ASCII letters.",
    );
    invariant(
      ++chunks <= 128 &&
        length <= 4 * 1024 * 1024 &&
        cursor + 12 + length <= bytes.length &&
        ["IHDR", "IDAT", "IEND", "sRGB", "pHYs", "gAMA", "cHRM"].includes(type),
      "REVIEW_IMAGE",
      "Unsupported PNG chunk, animation or oversized image data.",
    );
    invariant(
      crc32(bytes.subarray(cursor + 4, cursor + 8 + length)) ===
        bytes.readUInt32BE(cursor + 8 + length),
      "REVIEW_IMAGE",
      "PNG checksum mismatch.",
    );
    if (chunks === 1) {
      invariant(
        type === "IHDR" && length === 13,
        "REVIEW_IMAGE",
        "Missing PNG header.",
      );
      width = bytes.readUInt32BE(cursor + 8);
      height = bytes.readUInt32BE(cursor + 12);
      const depth = bytes[cursor + 16],
        color = bytes[cursor + 17];
      channels = color === 2 ? 3 : 4;
      invariant(
        width > 0 &&
          height > 0 &&
          width <= 1600 &&
          height <= 1200 &&
          width * height <= 1920000 &&
          depth === 8 &&
          [2, 6].includes(color) &&
          bytes[cursor + 18] === 0 &&
          bytes[cursor + 19] === 0 &&
          bytes[cursor + 20] === 0,
        "REVIEW_IMAGE",
        "Screenshots require bounded non-interlaced 8-bit RGB/RGBA dimensions.",
      );
    } else invariant(type !== "IHDR", "REVIEW_IMAGE", "Duplicate PNG header.");
    if (type === "IDAT") {
      invariant(
        !dataEnded,
        "REVIEW_IMAGE",
        "PNG image data must be contiguous.",
      );
      data.push(bytes.subarray(cursor + 8, cursor + 8 + length));
    } else if (data.length) dataEnded = true;
    cursor += length + 12;
    if (type === "IEND") {
      invariant(
        length === 0 && cursor === bytes.length,
        "REVIEW_IMAGE",
        "Unexpected data after PNG end.",
      );
      ended = true;
      break;
    }
  }
  invariant(
    ended && data.length > 0,
    "REVIEW_IMAGE",
    "Incomplete PNG screenshot.",
  );
  const row = 1 + width * channels,
    expected = row * height;
  const input = Buffer.concat(data);
  const result = inflateSync(input, {
    maxOutputLength: expected + 1,
    info: true,
  }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  invariant(
    result.engine.bytesWritten === input.length,
    "REVIEW_IMAGE",
    "Unexpected trailing PNG compressed data.",
  );
  const decoded = result.buffer;
  invariant(
    decoded.length === expected,
    "REVIEW_IMAGE",
    "PNG actual expansion does not match its dimensions.",
  );
  for (let y = 0; y < height; y++)
    invariant(
      decoded[y * row] <= 4,
      "REVIEW_IMAGE",
      "Unsupported PNG row filter.",
    );
  return { width, height, channels, decoded };
}
export function rasterHasInk(bytes: Buffer) {
  const { width, height, channels, decoded } = validatePng(bytes),
    stride = width * channels;
  let previous = Buffer.alloc(stride),
    row = Buffer.alloc(stride),
    dark = 0,
    light = 0;
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c,
      aa = Math.abs(p - a),
      bb = Math.abs(p - b),
      cc = Math.abs(p - c);
    return aa <= bb && aa <= cc ? a : bb <= cc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const offset = y * (stride + 1),
      filter = decoded[offset];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? row[x - channels] : 0,
        up = previous[x],
        upperLeft = x >= channels ? previous[x - channels] : 0;
      const prediction =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, upperLeft);
      row[x] = (decoded[offset + 1 + x] + prediction) & 255;
    }
    for (let x = 0; x < stride; x += channels) {
      const alpha = channels === 4 ? row[x + 3] / 255 : 1;
      // Composite against the white export background; transparent RGB is not ink.
      if ([0, 1, 2].every((c) => row[x + c] * alpha + 255 * (1 - alpha) < 180))
        dark++;
      if ([0, 1, 2].every((c) => row[x + c] * alpha + 255 * (1 - alpha) > 220))
        light++;
    }
    const swap = previous;
    previous = row;
    row = swap;
  }
  const minimum = Math.max(
    1,
    Math.min(1000, Math.floor((width * height) / 100)),
  );
  return (
    width >= 640 &&
    height >= 360 &&
    Math.abs(width / height - 16 / 9) < 0.02 &&
    dark >= minimum &&
    light >= minimum
  );
}

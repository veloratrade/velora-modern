// Screenshot request boundary — validated bytes only, no filesystem or provider work.
//
// This deliberately mirrors Legacy ScreenshotExtractController's hard limits:
// four images, 8 MiB/image, 16 MiB combined, PNG/JPEG/WebP, 32..6000 px per side,
// and 12 million pixels. Dimensions are read from the container headers before
// any OCR/provider sees the bytes; image libraries are not asked to guess.

export const MAX_SCREENSHOT_IMAGES = 4;
export const MAX_SCREENSHOT_IMAGE_BYTES = 8_388_608;
export const MAX_SCREENSHOT_TOTAL_BYTES = 16_777_216;
export const MAX_SCREENSHOT_PIXELS = 12_000_000;
export const MAX_SCREENSHOT_SIDE = 6_000;
/** Base64 expansion of the combined raw-byte cap plus JSON/data-URL overhead. */
export const MAX_SCREENSHOT_REQUEST_BYTES = 24 * 1024 * 1024;
export const SCREENSHOT_DEADLINE_MS = 30_000;

export type ScreenshotMimeType = "image/png" | "image/jpeg" | "image/webp";

export interface DecodedScreenshot {
  readonly bytes: Buffer;
  readonly mimeType: ScreenshotMimeType;
  readonly width: number;
  readonly height: number;
}

export class ScreenshotInputError extends Error {
  constructor(readonly field: string, readonly reason: string) {
    super("Invalid screenshot request.");
    this.name = "ScreenshotInputError";
  }
}

const DECLARED_TYPES: Readonly<Record<string, ScreenshotMimeType>> = {
  "data:image/png;base64,": "image/png",
  "data:image/jpeg;base64,": "image/jpeg",
  "data:image/webp;base64,": "image/webp",
};

const MAX_IMAGE_BASE64_CHARS = Math.ceil(MAX_SCREENSHOT_IMAGE_BYTES * 4 / 3) + 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** Decode and validate the complete `images[]` body before doing any work. */
export function decodeScreenshotImages(value: unknown): DecodedScreenshot[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ScreenshotInputError("images", "required_non_empty_array");
  }
  if (value.length > MAX_SCREENSHOT_IMAGES) {
    throw new ScreenshotInputError("images", `maximum_${MAX_SCREENSHOT_IMAGES}`);
  }

  let totalBytes = 0;
  const decoded: DecodedScreenshot[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const dataUrl = value[index];
    const field = `images.${index}`;
    if (typeof dataUrl !== "string") throw new ScreenshotInputError(field, "must_be_data_url");

    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new ScreenshotInputError(field, "invalid_data_url");
    const mimeType = DECLARED_TYPES[dataUrl.slice(0, comma + 1)];
    if (mimeType === undefined) throw new ScreenshotInputError(field, "unsupported_image_type");

    const encoded = dataUrl.slice(comma + 1);
    if (encoded.length === 0) throw new ScreenshotInputError(field, "empty_image");
    if (encoded.length > MAX_IMAGE_BASE64_CHARS) throw new ScreenshotInputError(field, "image_too_large");
    if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) {
      throw new ScreenshotInputError(field, "invalid_base64");
    }

    const bytes = Buffer.from(encoded, "base64");
    if (bytes.length === 0 || bytes.length > MAX_SCREENSHOT_IMAGE_BYTES || bytes.toString("base64") !== encoded) {
      throw new ScreenshotInputError(field, bytes.length > MAX_SCREENSHOT_IMAGE_BYTES ? "image_too_large" : "invalid_base64");
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_SCREENSHOT_TOTAL_BYTES) {
      throw new ScreenshotInputError("images", "combined_images_too_large");
    }

    const actualType = sniffImageType(bytes);
    if (actualType === null) throw new ScreenshotInputError(field, "invalid_image");
    if (actualType !== mimeType) throw new ScreenshotInputError(field, "image_type_mismatch");

    const dimensions = readImageDimensions(bytes, actualType);
    if (dimensions === null) throw new ScreenshotInputError(field, "invalid_image");
    const { width, height } = dimensions;
    if (width < 32 || height < 32 || width > MAX_SCREENSHOT_SIDE || height > MAX_SCREENSHOT_SIDE || width * height > MAX_SCREENSHOT_PIXELS) {
      throw new ScreenshotInputError(field, "unsupported_dimensions");
    }
    decoded.push({ bytes, mimeType: actualType, width, height });
  }
  return decoded;
}

function sniffImageType(bytes: Buffer): ScreenshotMimeType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

function readImageDimensions(bytes: Buffer, mimeType: ScreenshotMimeType): { width: number; height: number } | null {
  if (mimeType === "image/png") return readPngDimensions(bytes);
  if (mimeType === "image/jpeg") return readJpegDimensions(bytes);
  return readWebpDimensions(bytes);
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 45 || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  let sawImageData = false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const chunkBytes = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const payload = offset + 8;
    const next = payload + chunkBytes + 4; // data plus CRC
    if (next > bytes.length) return null;
    if (offset === 8 && (type !== "IHDR" || chunkBytes !== 13)) return null;
    if (type === "IDAT" && chunkBytes > 0) sawImageData = true;
    if (type === "IEND") {
      return chunkBytes === 0 && sawImageData && next === bytes.length ? dimensions : null;
    }
    offset = next;
  }
  return null;
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  let offset = 2;
  let dimensions: { width: number; height: number } | null = null;
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length - 2 && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length - 2) return null;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9) return null; // A complete image needs a scan before EOI.
    if (marker === 0xda) {
      if (dimensions === null || offset + 2 > bytes.length - 2) return null;
      const scanHeaderBytes = bytes.readUInt16BE(offset);
      if (scanHeaderBytes < 6 || offset + scanHeaderBytes >= bytes.length - 2) return null;
      return dimensions; // SOS begins compressed data; EOI was checked at the file end.
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // standalone markers
    if (offset + 2 > bytes.length - 2) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length - 2) return null;
    if (isStartOfFrame(marker)) {
      if (segmentLength < 7) return null;
      dimensions = { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function isStartOfFrame(marker: number): boolean {
  return [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker);
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 25 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return null;
  const riffBytes = bytes.readUInt32LE(4) + 8;
  if (riffBytes < 25 || riffBytes !== bytes.length) return null;

  let offset = 12;
  while (offset + 8 <= riffBytes) {
    const chunkType = bytes.toString("ascii", offset, offset + 4);
    const chunkBytes = bytes.readUInt32LE(offset + 4);
    const payload = offset + 8;
    if (payload + chunkBytes > riffBytes) return null;

    if (chunkType === "VP8X" && chunkBytes >= 10) {
      return {
        width: 1 + bytes.readUIntLE(payload + 4, 3),
        height: 1 + bytes.readUIntLE(payload + 7, 3),
      };
    }
    if (chunkType === "VP8 " && chunkBytes >= 10) {
      if (bytes[payload + 3] !== 0x9d || bytes[payload + 4] !== 0x01 || bytes[payload + 5] !== 0x2a) return null;
      return {
        width: bytes.readUInt16LE(payload + 6) & 0x3fff,
        height: bytes.readUInt16LE(payload + 8) & 0x3fff,
      };
    }
    if (chunkType === "VP8L" && chunkBytes >= 5) {
      if (bytes[payload] !== 0x2f) return null;
      const b1 = bytes[payload + 1]!;
      const b2 = bytes[payload + 2]!;
      const b3 = bytes[payload + 3]!;
      const b4 = bytes[payload + 4]!;
      return {
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + ((b2 >> 6) & 0x03) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }

    offset = payload + chunkBytes + (chunkBytes & 1);
  }
  return null;
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeScreenshotImages, MAX_SCREENSHOT_IMAGES, MAX_SCREENSHOT_IMAGE_BYTES, ScreenshotInputError } from "./screenshotExtraction.js";

const PNG = readFileSync(new URL("./__fixtures__/ocr-trade-screenshot.png", import.meta.url));
const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString("base64")}`;

function jpeg(width: number, height: number): Buffer {
  // SOI + SOF0 (three components) + SOS + one scan byte + EOI. This is a
  // structural parser fixture; OCR quality is tested with the checked-in PNG.
  const bytes = Buffer.alloc(2 + 2 + 2 + 1 + 2 + 2 + 1 + 9 + 2 + 2 + 4 + 1 + 2);
  let offset = 0;
  bytes.set([0xff, 0xd8], offset); offset += 2;
  bytes.set([0xff, 0xc0], offset); offset += 2;
  bytes.writeUInt16BE(17, offset); offset += 2;
  bytes[offset++] = 8;
  bytes.writeUInt16BE(height, offset); offset += 2;
  bytes.writeUInt16BE(width, offset); offset += 2;
  bytes[offset++] = 3;
  bytes.fill(1, offset, offset + 9); offset += 9;
  bytes.set([0xff, 0xda], offset); offset += 2;
  bytes.writeUInt16BE(6, offset); offset += 2;
  bytes.fill(0, offset, offset + 4); offset += 4;
  bytes[offset++] = 0x11;
  bytes.set([0xff, 0xd9], offset);
  return bytes;
}

function webpVp8x(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

function rejects(value: unknown, reason: string): void {
  assert.throws(() => decodeScreenshotImages(value), (err: unknown) => err instanceof ScreenshotInputError && err.reason === reason);
}

test("strict PNG, JPEG and WebP data URLs decode to bounded bytes and header dimensions", () => {
  const png = decodeScreenshotImages([dataUrl("image/png", PNG)])[0]!;
  assert.equal(png.mimeType, "image/png");
  assert.equal(png.width, 1000);
  assert.equal(png.height, 420);
  assert.deepEqual(png.bytes, PNG);

  const jpg = decodeScreenshotImages([dataUrl("image/jpeg", jpeg(320, 240))])[0]!;
  assert.equal(jpg.mimeType, "image/jpeg");
  assert.equal(jpg.width, 320);
  assert.equal(jpg.height, 240);

  const webp = decodeScreenshotImages([dataUrl("image/webp", webpVp8x(640, 480))])[0]!;
  assert.equal(webp.mimeType, "image/webp");
  assert.equal(webp.width, 640);
  assert.equal(webp.height, 480);
});

test("empty, excessive, malformed, mismatched, and non-canonical base64 inputs are refused", () => {
  rejects([], "required_non_empty_array");
  rejects(Array.from({ length: MAX_SCREENSHOT_IMAGES + 1 }, () => dataUrl("image/png", PNG)), "maximum_4");
  rejects(["data:image/png;base64,AAAA"], "invalid_image");
  rejects([dataUrl("image/jpeg", PNG)], "image_type_mismatch");
  rejects(["data:image/png;base64,AA=A"], "invalid_base64");
  rejects(["data:image/gif;base64,AAAA"], "unsupported_image_type");
  rejects(["data:image/png;base64,"], "empty_image");
});

test("dimensions and byte limits fail closed before any OCR/provider call", () => {
  const tooSmall = jpeg(31, 32);
  rejects([dataUrl("image/jpeg", tooSmall)], "unsupported_dimensions");
  const tooLarge = jpeg(6001, 32);
  rejects([dataUrl("image/jpeg", tooLarge)], "unsupported_dimensions");

  const overCap = "A".repeat(Math.ceil(MAX_SCREENSHOT_IMAGE_BYTES * 4 / 3) + 8);
  rejects([`data:image/png;base64,${overCap}`], "image_too_large");
});

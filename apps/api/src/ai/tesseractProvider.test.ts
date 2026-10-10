import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiFailure } from "./aiErrors.js";
import {
  findTesseractBinary,
  TESSERACT_MAX_OUTPUT_BYTES,
  TesseractProvider,
} from "./tesseractProvider.js";

function executableScript(contents: string): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "velora-tesseract-test-"));
  const path = join(root, "fake-tesseract");
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
  return { root, path };
}

test("OCR binary probing accepts only an executable regular file", () => {
  const root = mkdtempSync(join(tmpdir(), "velora-tesseract-probe-"));
  try {
    const directory = join(root, "directory");
    const nonExecutable = join(root, "not-executable");
    const executable = join(root, "executable");
    mkdirSync(directory);
    writeFileSync(nonExecutable, "not a program", { mode: 0o600 });
    chmodSync(nonExecutable, 0o600);
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    chmodSync(executable, 0o700);

    assert.equal(findTesseractBinary([directory, nonExecutable, executable]), executable);
    assert.equal(findTesseractBinary([directory, nonExecutable]), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OCR process output is capped in UTF-8 bytes, not JavaScript characters", async () => {
  const excessCharacters = Math.floor(TESSERACT_MAX_OUTPUT_BYTES / 2) + 1;
  const script = executableScript(`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify("é".repeat(excessCharacters))});\n`);
  try {
    const provider = new TesseractProvider({ binaryPath: script.path, timeoutMs: 3_000 });
    assert.equal(provider.isAvailable(), true);
    await assert.rejects(
      provider.ocr(Buffer.from("validated image")),
      (error: unknown) => error instanceof AiFailure && error.code === "OCR_FAILED",
      "a multibyte stream over 256 KiB must be rejected even if its JS string is shorter",
    );
  } finally {
    rmSync(script.root, { recursive: true, force: true });
  }
});

test("OCR process timeout is enforced and classified separately from output overflow", async () => {
  const script = executableScript("#!/usr/bin/env node\nsetTimeout(() => {}, 10_000);\n");
  try {
    const provider = new TesseractProvider({ binaryPath: script.path, timeoutMs: 500 });
    await assert.rejects(
      provider.ocr(Buffer.from("validated image")),
      (error: unknown) => error instanceof AiFailure && error.code === "PROVIDER_TIMEOUT",
    );
  } finally {
    rmSync(script.root, { recursive: true, force: true });
  }
});

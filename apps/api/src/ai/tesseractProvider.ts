// Tesseract — the LOCAL OCR fallback.
//
// WHY IT MATTERS. It is the only provider in the chain that needs no credential,
// no network and no third party. When Gemini is region-blocked, out of quota, or
// simply not configured, a screenshot still yields text on this machine — and,
// just as important, an image that cannot be anonymized never has to leave the
// building to be read. Legacy seeds exactly this chain:
// `screenshot_extraction → gemini (1) → tesseract (2)`.
//
// WHAT IS MIGRATED AND WHAT IS NOT (both recorded in the phase-7 map §3):
//   * migrated: binary probing, the 0600 temp file, the `--psm 6 --oem 1`
//     invocation, the 8 MB image / 8 s process / 256 KB output bounds, the
//     "OCR is low confidence by nature" constant (Legacy's own 0.4), and the
//     honest refusal of a text-only request (`UNSUPPORTED_CAPABILITY` — an OCR
//     engine asked to write an essay must say no rather than improvise);
//   * NOT migrated: Legacy's GD pre-processing (crop the right-hand region,
//     upscale, grayscale, negate, contrast −35) and its `fas` language pack for
//     Persian digits. Modern has no image library, and adding one is a dependency
//     decision rather than a migration step, so the image goes to tesseract
//     as-is. The consequence is stated plainly: lower accuracy on hard
//     screenshots, which is why the confidence is low and why every OCR result in
//     this product is a DRAFT the user confirms, never an authoritative record.
//
// VERIFIED LOCALLY: tesseract 5.5.0 is installed in this environment, so the
// OCR path is exercised against the real binary in `aiProvider.test.ts` and in
// the real-PostgreSQL battery — not only against an injected fake.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiFailure, refused, failed } from "./aiErrors.js";

/** Legacy's bounds, kept verbatim: they are the difference between OCR and a DoS. */
export const TESSERACT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const TESSERACT_PROCESS_TIMEOUT_MS = 8_000;
export const TESSERACT_MAX_OUTPUT_BYTES = 262_144;
/** Legacy's constant: OCR output is a low-confidence reading, never a fact. */
export const TESSERACT_CONFIDENCE = 0.4;
/** Where Legacy looks. A caller may widen it; nothing here shells out to `$PATH`. */
export const TESSERACT_CANDIDATE_PATHS = ["/usr/bin/tesseract", "/usr/local/bin/tesseract", "/bin/tesseract"] as const;

export interface OcrResult {
  readonly text: string;
  readonly confidence: number;
  readonly model: "tesseract";
  readonly latencyMs: number;
  readonly language: string;
}

export interface TesseractOptions {
  /** Injected in tests; defaults to probing the candidate paths. */
  readonly binaryPath?: string | null;
  readonly language?: string;
  readonly timeoutMs?: number;
}

/** Find an executable tesseract, or null. A missing binary is not an exception. */
export function findTesseractBinary(candidates: readonly string[] = TESSERACT_CANDIDATE_PATHS): string | null {
  for (const path of candidates) {
    try {
      if (existsSync(path)) return path;
    } catch {
      // An unreadable path is simply "not usable" — Legacy suppresses the same
      // probe error, because a warning here would corrupt a JSON response and
      // leak a server path.
    }
  }
  return null;
}

export class TesseractProvider {
  readonly name = "tesseract" as const;
  readonly capabilities = ["ocr", "text"] as const;
  readonly costTier = 0 as const;
  readonly #binary: string | null;
  readonly #language: string;
  readonly #timeoutMs: number;

  constructor(options: TesseractOptions = {}) {
    this.#binary = options.binaryPath !== undefined ? options.binaryPath : findTesseractBinary();
    this.#language = options.language ?? "eng";
    this.#timeoutMs = options.timeoutMs ?? TESSERACT_PROCESS_TIMEOUT_MS;
  }

  /** Available means "the binary is really there", not "we hope it is". */
  isAvailable(): boolean {
    return this.#binary !== null;
  }

  get binaryPath(): string | null {
    return this.#binary;
  }

  /**
   * Read text out of an image.
   *
   * The image is written to a 0600 file inside a private temp directory and the
   * directory is removed afterwards: a user's screenshot must not be left
   * world-readable on disk by the OCR fallback.
   */
  async ocr(image: Buffer, timeoutMs = this.#timeoutMs): Promise<OcrResult> {
    if (this.#binary === null) throw failed("OCR_UNAVAILABLE", "tesseract", false);
    if (image.length === 0 || image.length > TESSERACT_MAX_IMAGE_BYTES) {
      throw new AiFailure("PAYLOAD_TOO_LARGE", "refused", "tesseract", false, "image outside the OCR size bound");
    }

    const started = Date.now();
    const dir = mkdtempSync(join(tmpdir(), "velora-ocr-"));
    const input = join(dir, "input.img");
    try {
      writeFileSync(input, image);
      chmodSync(input, 0o600);
      const text = await this.#run(this.#binary, [input, "stdout", "-l", this.#language, "--psm", "6", "--oem", "1"], timeoutMs);
      return {
        text: text.replace(/\s+$/u, ""),
        confidence: TESSERACT_CONFIDENCE,
        model: "tesseract",
        latencyMs: Date.now() - started,
        language: this.#language,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * A text-only request is refused, not improvised. Legacy returns
   * `UNSUPPORTED_CAPABILITY` here; the chain then moves on to a provider that can
   * actually write prose.
   */
  refuseTextOnly(): AiFailure {
    return refused("UNSUPPORTED_CAPABILITY", "tesseract");
  }

  async #run(binary: string, args: readonly string[], timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(binary, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, Math.max(500, Math.min(timeoutMs, TESSERACT_PROCESS_TIMEOUT_MS)));

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        // The output bound is enforced while reading, not after: a runaway
        // process must not be able to allocate its way into the host.
        if (stdout.length > TESSERACT_MAX_OUTPUT_BYTES) {
          killed = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        // Kept bounded and never surfaced: tesseract writes warnings here, and a
        // warning can contain a filesystem path.
        stderr = (stderr + chunk.toString("utf8")).slice(0, 2048);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        void stderr;
        reject(failed("OCR_UNAVAILABLE", "tesseract", false));
        void err;
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed) {
          reject(failed("PROVIDER_TIMEOUT", "tesseract", true));
          return;
        }
        if (code !== 0) {
          reject(failed("OCR_FAILED", "tesseract", false));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

/**
 * The structured reading of OCR text.
 *
 * Legacy parses symbol/side/numbers out of the text with simple heuristics and
 * returns confidence 0.4. Modern keeps the same idea and the same honesty: every
 * field is nullable, nothing is invented to fill a gap, and the result is a DRAFT
 * that the existing Telegram confirmation flow shows to the user before anything
 * is written. A model — or an OCR engine — cannot create a financial record here.
 */
export interface OcrTradeFields {
  readonly symbol: string | null;
  readonly direction: "buy" | "sell" | null;
  readonly entryPrice: string | null;
  readonly stopLoss: string | null;
  readonly takeProfit: string | null;
}

/**
 * A symbol is only read when the image LABELS it. Taking the first uppercase word
 * in an OCR dump would return the broker's name ("VELORA MARKETS") as the
 * instrument, which is exactly the kind of confident wrong answer this module
 * exists to avoid: a null symbol is honest, a guessed one becomes a trade.
 */
const SYMBOL_PATTERN = /\b(?:symbol|pair|instrument|نماد)\b\s*[:\-]?\s*([A-Z]{2,10}(?:[./-][A-Z]{1,6})?)/iu;
const NUMBER_PATTERN = /-?\d[\d,]*(?:\.\d+)?/u;

function firstNumber(text: string, label: RegExp): string | null {
  const match = label.exec(text);
  if (match === null) return null;
  // The number may be before or after the label; take the nearest one that follows.
  const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 40);
  const number = NUMBER_PATTERN.exec(tail);
  return number === null ? null : number[0].replace(/,/gu, "");
}

export function parseOcrTradeFields(text: string): OcrTradeFields {
  const symbolMatch = SYMBOL_PATTERN.exec(text);
  const buy = /\b(buy|long|خرید)\b/iu.test(text);
  const sell = /\b(sell|short|فروش)\b/iu.test(text);
  return {
    symbol: symbolMatch === null ? null : symbolMatch[1]!,
    direction: buy && !sell ? "buy" : sell && !buy ? "sell" : null,
    entryPrice: firstNumber(text, /\b(entry|open(?:ed)?(?:\s+at)?|price|ورود)\b/iu),
    stopLoss: firstNumber(text, /\b(stop[\s-]?loss|sl|حد ضرر)\b/iu),
    takeProfit: firstNumber(text, /\b(take[\s-]?profit|tp|حد سود)\b/iu),
  };
}

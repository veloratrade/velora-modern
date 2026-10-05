// Image anonymization before external egress — the fail-closed privacy gate.
//
// Legacy's rule (`AI/Security/ImageAnonymizer` + `AIManager::generate`): every
// image sent to an EXTERNAL provider is anonymized first (the top 15 % is
// blurred, because that is where broker account numbers live), and if
// anonymization cannot be guaranteed the original image MUST NOT be sent — the
// chain skips that provider and the local OCR fallback handles the image instead.
// The file states it as a contract: "`anonymize()` returns null when
// anonymization cannot be guaranteed. Callers MUST treat null as a hard failure."
//
// MODERN'S POSITION, AND IT IS DELIBERATE. Blurring a region of a JPEG requires
// decoding and re-encoding it, which needs an image library; this repository has
// none, and adding one is a dependency decision, not a migration step. So the
// default anonymizer here reports exactly what Legacy reports when GD is missing:
// **"cannot guarantee" → null**. The consequence is the security property Legacy
// intended, not a workaround: an image is never sent to a third party by this
// code path, and the local OCR provider (which needs no anonymization because
// nothing leaves the machine) still reads it.
//
// What that means in practice, stated plainly for whoever reads this next:
// with the default wiring, `screenshot_extraction` resolves to Tesseract. If an
// operator wants Gemini vision, they must supply an anonymizer that can actually
// redact — and the seam to supply it is this interface, not a flag that pretends
// the redaction happened.

export interface AnonymizerInfo {
  readonly anonymized: boolean;
  readonly method: string;
  readonly topPercent: number;
  readonly failClosed: boolean;
}

export interface ImageAnonymizer {
  /** Legacy always answers true: every externally-bound image is treated as sensitive. */
  shouldAnonymize(image: Buffer): boolean;
  /** The redacted image, or null when redaction cannot be guaranteed. */
  anonymize(image: Buffer): Buffer | null;
  /** The real state of the last call — for the admin surface, never inferred. */
  info(): AnonymizerInfo;
}

export const BLUR_TOP_PERCENT = 15;

/**
 * The default: honest inability. Returns null for every image, which makes the
 * manager refuse external image egress and fall back to local OCR.
 */
export class UnavailableImageAnonymizer implements ImageAnonymizer {
  private lastResult: boolean | null = null;

  shouldAnonymize(): boolean {
    return true;
  }

  anonymize(): Buffer | null {
    this.lastResult = false;
    return null;
  }

  info(): AnonymizerInfo {
    const ok = this.lastResult === true;
    return {
      anonymized: ok,
      method: ok ? `blur_top_${BLUR_TOP_PERCENT}_percent` : "none",
      topPercent: ok ? BLUR_TOP_PERCENT : 0,
      failClosed: true,
    };
  }
}

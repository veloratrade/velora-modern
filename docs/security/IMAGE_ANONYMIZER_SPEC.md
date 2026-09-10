# Velora Modern — ImageAnonymizer & PII Scrubbing Specification

## Purpose

This document specifies the requirement, architecture, and fail-closed privacy safeguards for processing trade chart screenshots before sending them to external AI services (Google Gemini, OpenAI Vision) in **Velora Modern** (`veloratrade/velora-modern`). It adapts the legacy PHP `ImageAnonymizer.php` service logic.

---

## Background & Privacy Safeguards

Traders frequently upload chart screenshots from platforms such as MetaTrader 4, MetaTrader 5, or TradingView into their trade journal. These screenshots often contain sensitive personally identifiable information (PII) and financial details in the top header bar, including:
- Trading account login numbers (e.g., `Account: 8492041`)
- Broker server name (e.g., `ICMarkets-Real02`)
- Total account balance, equity, and margin
- Trader full name or email address

To comply with data privacy regulations and protect user identity, all images transmitted to third-party AI vision models MUST undergo automatic PII scrubbing.

---

## Technical Processing Pipeline

When a user requests AI trade analysis or automated chart pattern detection:

```
[ Uploaded Screenshot ] ──> [ ImageAnonymizer Service ]
                                   │
       ┌───────────────────────────┴───────────────────────────┐
       ▼                                                       ▼
1. Strip EXIF Metadata                            2. Redact Header Region
  - Camera info, GPS, timestamps                    - Apply blur/pixelate overlay
  - Software build details                          - Target top 15% image height
       │                                                       │
       └───────────────────────────┬───────────────────────────┘
                                   ▼
                   [ Anonymized Image Buffer ]
                                   │
                         (Verification Check)
                        /                    \
                     SUCCESS                FAILURE
                       /                        \
           [ Send to AI LLM ]              [ Fail-Closed: Return Null ]
```

### 1. EXIF Metadata Elimination
- All EXIF, IPTC, and XMP metadata (including camera model, software tags, geolocation, and creation timestamps) MUST be stripped completely from the image byte stream using image processing tools (e.g. `sharp` in Node.js).

### 2. Header Area Redaction / Blurring
- The top 15% vertical region ($y \in [0, 0.15 \times \text{height}]$) of the image MUST be obfuscated (`BLUR_TOP_PERCENT = 15`).
- Obfuscation MUST be achieved by applying Gaussian blur passes combined with pixelation (`IMG_FILTER_PIXELATE`, size 8).
- Output MUST be encoded as JPEG (quality 80) or WebP.

### 3. Byte-Identical Output Defense Check
- After anonymization, if the SHA-256 hash of the output image buffer is byte-identical to the input raw image buffer, the operation MUST be treated as a failure and return `null`.

### 4. Fail-Closed Privacy Policy
- If image loading, EXIF stripping, or redaction processing encounters an exception, memory error, GD/sharp missing dependency, or format corruption:
  - The pipeline MUST NOT fall back to sending the original unscrubbed image.
  - The pipeline MUST fail closed by returning `null`.
  - Callers MUST treat `null` as a hard failure and MUST NOT send raw unscrubbed images to third-party AI vision endpoints (local text fallback may still run).

---

## API & Service Contract

```typescript
export interface ImageAnonymizerOptions {
  headerBlurPercent?: number; // Default: 15 (0.15 * height)
  stripExif?: boolean;        // Default: true
}

export interface ImageAnonymizerResult {
  success: boolean;
  anonymizedBuffer?: Buffer;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  strippedMetadata: boolean;
  redactedHeader: boolean;
  error?: string;
}

export interface IImageAnonymizerService {
  anonymize(
    imageBuffer: Buffer,
    mimeType: string,
    options?: ImageAnonymizerOptions
  ): Promise<ImageAnonymizerResult>;
}
```

---

## Provenance & Traceability Matrix

| Requirement | PHP Evidence File | Classification | Modern Target Location | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Top 15% Header Blurring** | `api/src/AI/Security/ImageAnonymizer.php` (`BLUR_TOP_PERCENT = 15`) | `SECURITY_REQUIREMENT` | `docs/security/IMAGE_ANONYMIZER_SPEC.md` | `TRANSFER_COMPLETED` |
| **Fail-Closed Null Fallback** | `api/src/AI/Security/ImageAnonymizer.php` (Line 20) | `SECURITY_REQUIREMENT` | `docs/security/IMAGE_ANONYMIZER_SPEC.md` | `TRANSFER_COMPLETED` |
| **Byte-Identical Hash Guard** | `api/src/AI/Security/ImageAnonymizer.php` (Line 115) | `SECURITY_REQUIREMENT` | `docs/security/IMAGE_ANONYMIZER_SPEC.md` | `TRANSFER_COMPLETED` |
| **EXIF Metadata Removal** | `api/src/AI/Security/ImageAnonymizer.php` | `SECURITY_REQUIREMENT` | `docs/security/IMAGE_ANONYMIZER_SPEC.md` | `TRANSFER_COMPLETED` |

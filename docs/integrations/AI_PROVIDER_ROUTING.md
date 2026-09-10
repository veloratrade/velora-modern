# Velora Modern — AI Provider Routing & Vision Specification

## Purpose

This document specifies the multi-provider LLM routing engine, provider credential vault, usage quotas, prompt engineering templates, and chart OCR vision integration for **Velora Modern** (`veloratrade/velora-modern`). It reconciles legacy PHP implementations (`FeatureRouter.php`, `ProviderCatalog.php`, `v0.9_ai_provider_routing.sql`).

---

## 1. Multi-Provider Architecture

Velora Modern supports dynamic routing across multiple AI LLM providers (Google Gemini and OpenAI GPT-4o) to ensure high availability, cost efficiency, and latency optimization.

```
[ User Request ] ──> [ AI Feature Router ]
                            │
            ┌───────────────┴───────────────┐
            ▼                               ▼
   [ Google Gemini ]                 [ OpenAI GPT-4o ]
   (Primary / Vision)               (Secondary / Fallback)
```

---

## 2. Dynamic Provider Routing & Priority Matrix

| Provider ID | Provider Name | Primary Model | Vision Supported | Default Priority | Fallback Order |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `gemini` | Google Gemini | `gemini-1.5-flash` / `gemini-1.5-pro` | YES | 1 (Primary) | 2 |
| `openai` | OpenAI | `gpt-4o-mini` / `gpt-4o` | YES | 2 (Secondary) | 1 |

### Routing Logic
1. **Capability Matching**: Filter providers by required capability (e.g. `vision_ocr`, `text_generation`, `weekly_summary`).
2. **Health Check**: Filter out disabled or failing providers (`status === 'active'`).
3. **Priority Ordering**: Select provider with lowest numeric priority weight.
4. **Fallback Handling**: If primary provider call times out or throws HTTP 429/5xx, automatically retry request against secondary provider.

---

## 3. Provider Credential Vault & Quota Management

- AI API keys MUST be stored securely in the database (`ai_provider_configs` table) or environment variables.
- Secret keys in administrative view MUST be masked (e.g. `sk-proj-...8a1f`).
- **Quota Tracking**: Daily and monthly token consumption per user and system-wide MUST be tracked in `ai_usage_logs`.
- **Usage Limits**: Free plan users receive limited AI requests per day; Pro plan users receive standard monthly quotas.

---

## 4. Chart Screenshot OCR & Vision Pipeline

For chart screenshot analysis:
1. User uploads chart image alongside trade journal entry.
2. Image MUST pass through `ImageAnonymizer` to strip EXIF metadata and obscure header account numbers/balances.
3. If anonymization succeeds, the anonymized image buffer is encoded as base64 and sent to the selected vision provider (`gemini-1.5-flash` or `gpt-4o`).
4. System prompt instructs LLM to extract:
   - Chart Symbol / Ticker (e.g., `EURUSD`, `XAUUSD`)
   - Timeframe (e.g., `H1`, `M15`)
   - Identified Technical Patterns (e.g., `Double Bottom`, `Order Block`, `Trendline Break`)
   - Marked Entry, Stop Loss, and Take Profit levels if visible.
5. Extracted JSON response is validated with Zod schema before returning to user.

---

## 5. Security & Prompt Injection Defense

- User trade notes MUST be sanitized and separated from system instructions using strict prompt encapsulation.
- Prompts MUST explicitly forbid LLMs from executing external code or leaking system keys.
- User consent for sending chart images to third-party AI providers MUST be verified.

---

## Provenance & Traceability Matrix

| Requirement | PHP Evidence File | Classification | Modern Target Document | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Feature Router & Fallback** | `api/src/AI/Services/FeatureRouter.php` | `SHARED_ADAPTED` | `docs/integrations/AI_PROVIDER_ROUTING.md` | `TRANSFER_COMPLETED` |
| **Provider Catalog & OpenAI/Gemini** | `api/src/AI/Services/ProviderCatalog.php` | `SHARED_ADAPTED` | `docs/integrations/AI_PROVIDER_ROUTING.md` | `TRANSFER_COMPLETED` |
| **AI Request Logging & Cost Tracking** | `api/src/AI/Repositories/AIRequestRepository.php` | `SHARED_ADAPTED` | `docs/integrations/AI_PROVIDER_ROUTING.md` | `TRANSFER_COMPLETED` |
| **Database Schema Routing Rules** | `database/migrations/v0.9_ai_provider_routing.sql` | `SHARED_REQUIRED` | `prisma/schema.prisma` | `VERIFIED` |

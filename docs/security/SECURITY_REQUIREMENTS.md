# Velora Modern — Security Baseline & Requirements Specification

## Purpose

This document specifies the 34 mandatory security controls for **Velora Modern** (`veloratrade/velora-modern`). It adapts the legacy PHP security baseline (`docs/01_SECURITY_CHECKLIST.md`) for Node.js, Fastify, Prisma ORM, JOSE JWT, and Railway infrastructure.

---

## 34 Mandatory Security Controls

### 1. Sensitive File Exposure
- Application endpoints and public static routes MUST NOT expose `.env`, `.git`, Prisma schema files, test files, or database scripts.
- Health checks (`/health`) MUST NOT reveal internal infrastructure paths, raw database URLs, or secret keys.

### 2. Environment Variables & Secrets
- All credentials (database URLs, JWT secrets, MetaAPI tokens, Resend API keys, AI provider keys) MUST be loaded strictly via environment variables.
- Hardcoded secrets in source code, default fallback credentials in production code, or secret outputs in public logs are strictly prohibited.

### 3. Source Control Security
- Secrets and temporary files (`.env`, `.DS_Store`, `node_modules/`, `coverage/`) MUST be gitignored.
- Credentials must never be committed to Git history.

### 4. Authentication Architecture
- Authentication uses dual-token strategy: short-lived access JWTs (15-minute expiration) and long-lived refresh tokens (7-day expiration).
- Unauthenticated requests to protected endpoints MUST return HTTP 401 `UNAUTHORIZED`.

### 5. Password Security & Hashing
- Password hashing MUST use **Argon2id** (`argon2` algorithm) with memory cost 65536 KB (64 MB), time cost 4 iterations, parallelism 1, and salt length 16 bytes.
- Legacy bcrypt hashes from PHP migration MUST be supported for seamless password verification (remapping `$2y$` to `$2a$`) and upgraded to Argon2id upon user login.
- Minimum password length is 8 characters.

### 6. Authorization & Access Control (RBAC)
- Role-Based Access Control differentiates `user`, `admin`, and `super_admin`.
- User resources (trading accounts, trades, tags, analytics) MUST enforce strict tenant isolation using `where: { userId }` filters on every query.
- Administrative endpoints under `/api/v1/admin/*` MUST require `admin` or `super_admin` role.

### 7. API Security & Envelope Contract
- All API responses MUST adhere to the standardized response envelope: `{ status, data, error, timestamp }`.
- Request headers MUST be validated. Requests lacking valid JSON body content-types on POST/PUT endpoints MUST be rejected.

### 8. Input Validation & Data Sanitization
- All request parameters, query strings, and request bodies MUST be validated with Zod schemas.
- Symbol validation strictly permits `^[A-Za-z0-9_.\-\/]{1,30}$`.
- Trade prices, volumes, and account balances MUST be positive non-negative values.

### 9. SQL Injection Prevention
- Database access MUST use Prisma ORM parameterized query builders (`prisma.trade.findMany`, etc.).
- Raw SQL queries (`$queryRaw`) are restricted and MUST use parameterized tagged templates to prevent SQL injection.

### 10. Cross-Site Scripting (XSS) Prevention
- API responses MUST set `Content-Type: application/json; charset=utf-8`.
- User-supplied text strings (trade notes, journal entries) MUST be sanitized prior to storage and escaping enforced on frontend rendering.

### 11. CSRF Protection
- Refresh token cookies MUST use `SameSite=Strict` and `HttpOnly` attributes.
- State-changing API endpoints require JWT authentication headers (`Authorization: Bearer <access_token>`).

### 12. CORS Configuration
- CORS MUST be configured with strict origin allowlists via `CORS_ORIGIN` environment variables.
- Wildcard CORS (`Access-Control-Allow-Origin: *`) is strictly prohibited in staging and production environments.

### 13. Security Headers
- Helmet middleware MUST enforce HTTP security headers:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `X-XSS-Protection: 0`
  - `Cache-Control: no-store, max-age=0, private`
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains`

> **Owner decision implemented (D16 — 2026-09-12):** the owner approved
> option (a) — implementation aligned to §13. Enforced explicitly in
> `src/app.ts` (Helmet `frameguard: deny` + `hsts: maxAge 31536000,
> includeSubDomains` + `onSend` Cache-Control hook, all responses incl.
> errors) and locked by the committed headers test
> (`tests/integration/app.test.ts`) plus the smoke-suite assertion.
> Do not change either side without the other.

### 14. HTTPS & TLS Enforcement
- All network communications MUST be encrypted via HTTPS / TLS 1.2+.
- Unencrypted HTTP requests MUST be redirected to HTTPS.

### 15. Cookie Security
- Refresh token cookies MUST use the `__Host-velora_refresh` prefix in production.
- Cookie attributes MUST include `HttpOnly`, `Secure`, `SameSite=Strict`, and `Path=/`.

### 16. File Upload & Chart Screenshot Security
- Uploaded trade screenshots MUST be validated by MIME type (`image/png`, `image/jpeg`, `image/webp`).
- Maximum upload size is capped at 10 MB per file.
- Uploaded files MUST be stored in secure private storage or object store, never in web-root public directories.

### 17. Trade Screenshot Privacy (ImageAnonymizer)
- Screenshots sent to external AI services (Google Gemini, OpenAI Vision) MUST pass through PII scrubbing (`ImageAnonymizer`).
- Image EXIF metadata (camera info, GPS, timestamps) MUST be stripped.
- The top 15% header region containing sensitive trading account numbers and balances MUST be blurred/redacted.
- If anonymization fails, the image pipeline MUST fail closed and fall back to null before calling external LLM APIs.

### 18. Path Traversal Prevention
- User input MUST NEVER be directly concatenated into filesystem paths.
- Filename parameters MUST be sanitized with path boundary checks (`path.basename`).

### 19. Server-Side Request Forgery (SSRF) Defense
- Outbound requests (webhooks, MetaAPI calls) MUST validate target domain URLs against permitted protocol and host allowlists.
- Requests to internal private IP address ranges (`127.0.0.1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) MUST be blocked.

### 20. Webhook Security & HMAC Verification
- Incoming webhooks (MetaAPI, payment providers) MUST verify cryptographic HMAC SHA-256 signatures (`x-signature` header).
- Replay attacks MUST be mitigated using webhook timestamp verification (5-minute tolerance window) and event idempotency keys.

### 21. Rate Limiting & Denial-of-Service Defense
- API endpoints MUST be protected by Fastify rate limiting:
  - Public authentication routes: Max 10 requests / minute per IP.
  - Standard API routes: Max 100 requests / minute per user/IP.
  - Webhook endpoints: Max 300 requests / minute per IP.
- Exceeding rate limits MUST return HTTP 429 `TOO_MANY_REQUESTS`.

### 22. AI Security & Prompt Injection Defense
- AI prompts MUST be constructed using system instructions separate from user input.
- User-supplied journal entries, trade notes, or OCR text MUST be wrapped in safe boundaries.
- Provider credentials and API keys MUST NEVER be included in LLM prompt contexts.
- User consent MUST be verified before transmitting trade data to third-party AI services.

### 23. Payment & Entitlement Security
- Commercial entitlement enforcement MUST be validated on the backend before executing resource creation:
  - **Free Plan**: Maximum 1 Trading Account (MT4, MT5, or MANUAL).
  - **Pro Plan**: Unlimited Trading Accounts.
  - Projects are explicitly excluded from account quota restrictions.
- Upgrade/downgrade hooks MUST enforce immediate quota compliance.

### 24. Standardized Error Handling
- Internal exceptions, database stack traces, or framework internals MUST NEVER be leaked in API responses.
- Production error responses return sanitized error messages and standard HTTP code mappings (400, 401, 403, 404, 429, 500, 503).

### 25. Environment & Debug Mode Safety
- Debug logging MUST be disabled in production (`NODE_ENV === 'production'`).
- Detailed error stack traces are restricted to local development environments.

### 26. Fail-Closed Database Connection Safety
- If the primary database connection fails during request authentication, rate limiting, or session verification:
  - In `production` and `development` environments, the system MUST fail closed by returning HTTP 503 `SERVICE_UNAVAILABLE`.
  - In-memory store (`MemoryStore`) fallback is permitted strictly in `test` environment (`NODE_ENV === 'test'`).

### 27. Database Backup & Data Protection
- Database backups MUST be automated, encrypted at rest, and stored offsite.
- Database access credentials MUST be rotated regularly.

### 28. Railway Infrastructure & Container Isolation
- Modern runtime environments MUST run inside non-root Docker containers.
- Ports MUST bind to `0.0.0.0` inside container and exposed via HTTPS ingress proxies.

### 29. Dependency Management & Vulnerability Scanning
- Package dependencies MUST be audited regularly (`npm audit`).
- Package versions MUST be pinned using `package-lock.json`.

### 30. Client-Side Security & Token Storage
- Client applications MUST store short-lived JWT access tokens in memory or secure state.
- Refresh tokens MUST be stored exclusively in `HttpOnly`, `SameSite=Strict` cookies.

### 31. Admin Suite Security
- Administrative routes (`/api/v1/admin/*`) require dedicated `admin` / `super_admin` permissions.
- Sensitive administrative operations (updating AI provider keys, toggling feature flags, viewing system logs) MUST generate immutable audit log records in `audit_logs` table.

### 32. Information Disclosure Minimization
- Server banners (`Server`, `X-Powered-By`) MUST be stripped from HTTP response headers.
- API endpoints MUST NOT leak user account existence during password resets or login failures.

### 33. HTTP Method Restriction
- API routes MUST explicitly reject unsupported HTTP methods with HTTP 405 `METHOD_NOT_ALLOWED`.

### 34. Automated Security Regression Testing
- Security controls MUST be verified continuously by automated tests (`npm run test` executing `remediation.test.ts`, `errors.test.ts`, `auth.test.ts`).

---

## Provenance & Traceability Matrix

| Security Control | PHP Reference Evidence | Classification | Modern Target Location | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Argon2id & Bcrypt Remap** | `AuthService.php` / `01_SECURITY_CHECKLIST.md` | `SECURITY_REQUIREMENT` | `src/modules/auth/`, `tests/unit/password.test.ts` | `VERIFIED` |
| **JOSE HS256 JWT & Refresh Cookie** | `JwtService.php` / `SessionManager.php` | `SECURITY_REQUIREMENT` | `src/modules/auth/`, `tests/unit/jwt.test.ts` | `VERIFIED` |
| **RBAC & Ownership Isolation** | `Role.php` / `TradeService.php` | `SECURITY_REQUIREMENT` | `src/modules/auth/roles.ts`, `src/modules/trades/` | `VERIFIED` |
| **Fail-Closed DB Safety** | `DatabaseException.php` | `SECURITY_REQUIREMENT` | `src/core/errors/`, `tests/unit/remediation.test.ts` | `VERIFIED` |
| **Screenshot Privacy (ImageAnonymizer)** | `ImageAnonymizer.php` | `SECURITY_REQUIREMENT` | `docs/security/IMAGE_ANONYMIZER_SPEC.md` | `TRANSFER_COMPLETED` |
| **MetaAPI HMAC Webhook Security** | `MetaApiWebhookController.php` | `SECURITY_REQUIREMENT` | `docs/integrations/METAAPI_SPECIFICATION.md` | `TRANSFER_COMPLETED` |

-- 0039_ai_tool_secrets.sql — admin-managed credentials for the AI TOOLS (search, browser).
--
-- WHY THIS EXISTS AT ALL
--   0028 put platform AI secrets in `ai_platform_secrets` as AES-256-GCM envelopes and pinned the
--   acceptable key names with an inline CHECK. That closed list is the point of the table: a secret
--   store that accepts any name becomes a general key-value table, and the audit trail stops meaning
--   "a credential was changed" and starts meaning "something was written".
--
--   The Telegram agent's research and chart-capture tools need credentials too — a search key, and the
--   origin plus token of the browser service. They are stored the same way for the same reasons, so
--   this migration only widens the vocabulary. Nothing here stores a plaintext value; the encryption,
--   the fingerprint, the fail-closed-without-a-master-key rule and the "never return a value over
--   HTTP" rule all already exist in `AiSecretService` and are reused unchanged.
--
-- WHY THESE NAMES AND NOT A GENERIC "TOOL_CONFIG" ROW
--   Each key is a credential a specific provider accepts, named exactly as its own documentation
--   names it, because the resolution order is "admin-managed envelope → process ENV → unavailable"
--   and the env tier is the same name. One key holding a JSON blob of several providers' secrets would
--   break that parity, would make rotation all-or-nothing, and would let a single leaked value expose
--   every tool at once.
--
-- BROWSERLESS_URL IS A URL, AND IT IS STILL CALLED A SECRET
--   A self-hosted browser endpoint is not secret in the "API key" sense, but it IS sensitive: it is the
--   origin our process sends authenticated requests to, and its token is frequently carried in its
--   query string by the client libraries around it. Storing it in the same envelope table means the
--   same rules apply to it — encrypted at rest, never echoed by the status endpoint, fingerprinted so
--   an operator can see it changed. That is a better default than a plain settings row.
--
-- FORWARD-ONLY, WIDENING. No existing row is read, rewritten or deleted: every value the old CHECK
-- accepted is still accepted. A key that is not on this list is still refused by the database, which is
-- what the application's own validation is backed by rather than duplicated by.

ALTER TABLE ai_platform_secrets DROP CONSTRAINT IF EXISTS ai_platform_secrets_secret_key_check;
ALTER TABLE ai_platform_secrets ADD CONSTRAINT ai_platform_secrets_secret_key_check
  CHECK (secret_key IN (
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_RELAY_URL',
    'GEMINI_RELAY_TOKEN',
    'TAVILY_API_KEY',
    'BRAVE_SEARCH_API_KEY',
    'SERPER_API_KEY',
    'BROWSERLESS_URL',
    'BROWSERLESS_TOKEN'
  ));

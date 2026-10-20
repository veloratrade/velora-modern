-- 0042_telegram_post_preferences.sql — the settings a navigable menu needs to actually remember.
--
-- WHY THIS TABLE EXISTS
--   Round 7 turns the bot's functionality into buttons, and three of those screens offer a choice the
--   user expects to still be in force tomorrow: the DEFAULT template `/post` builds from, whether a
--   prepared post also builds the banner card, and an optional title override for that card. There was
--   no place to put any of it. The alternatives were read, not guessed:
--
--     * `telegram_post_templates` (0037) stores a template VERSION. "Which one is the default" is a
--       fact about the USER, not about a version — and modelling it as a row with a magic name would
--       make a user's real template called `default` unrepresentable;
--     * `telegram_channels` (0023/0038) is about verification of a destination, not about rendering;
--     * `email_preferences` (0003) is a boolean matrix for a different medium;
--     * `ai_settings` / `integration_settings` are ADMIN-owned blobs for server configuration, not
--       per-user bot UI state, and writing a user's default template there would hand them a row the
--       admin console considers its own.
--
--   So this is one narrow, user-scoped row. It is deliberately NOT a generic key/value settings table:
--   a KV blob cannot constrain what a value may be, which is exactly how "style = <anything>" ends up
--   in a renderer that supports one style.
--
-- WHY THE FLOW COLUMNS LIVE HERE TOO
--   The guided "create a template" conversation spans two messages (name, then body). A pending step
--   has to survive a redeploy, a rolling restart and the two-process deployment (API + Worker), so it
--   cannot be an in-memory map, and inventing a second table for three columns would be a worse trade
--   than three nullable columns with a coherence CHECK. The flow EXPIRES by `flow_started_at` in the
--   caller (15 minutes), because a prompt the user abandoned last week must not capture their next
--   sentence — and that is why the timestamp is NOT NULL exactly when a flow is open.
--
-- WHY THE CONSTRAINTS ARE THIS SHAPE
--   * `default_template_name` is a NAME and not an FK: the authoritative row is
--     `telegram_post_templates` filtered to `superseded_at IS NULL`, and a generated column cannot
--     reference a partial index. The store therefore refuses an unknown name on write, and retiring a
--     template clears a default that pointed at it — both are asserted in tests rather than assumed.
--   * `banner_enabled` defaults TRUE because the banner is the product's existing behaviour; this row
--     records a CHANGE, so absence of a row and a row that says TRUE mean the same thing.
--   * `banner_title` is capped at 60 characters: the banner composer truncates a longer title with an
--     ellipsis, and a setting the renderer silently shortens is a setting that lies about itself.
--   * the `flow_coherent` CHECK makes a half-open flow unrepresentable: either every flow column is
--     NULL, or the kind and its start time are both present. A kind without a timestamp would never
--     expire.
--
-- No row is rewritten, nothing is dropped, and no existing table changes shape. Forward-only.

CREATE TABLE IF NOT EXISTS telegram_post_preferences (
  user_id               BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,

  -- The template `/post` uses when the user names none. NULL means "ask me" (the current behaviour).
  default_template_name TEXT CHECK (default_template_name IS NULL OR length(btrim(default_template_name)) BETWEEN 1 AND 64),

  -- Build the banner card alongside the text when a prepared post is previewed.
  banner_enabled        BOOLEAN NOT NULL DEFAULT TRUE,

  -- An optional title for that card. NULL means the template's own title, which is what ships today.
  banner_title          TEXT CHECK (banner_title IS NULL OR length(btrim(banner_title)) BETWEEN 1 AND 60),

  -- One open guided flow per user, or none. Kinds are closed: a new step is a migration, by design.
  flow_kind             TEXT CHECK (flow_kind IS NULL OR flow_kind IN ('tpl_new_name', 'tpl_new_body', 'tpl_edit_body', 'banner_title')),
  flow_name             TEXT CHECK (flow_name IS NULL OR length(btrim(flow_name)) BETWEEN 1 AND 64),
  flow_body             TEXT CHECK (flow_body IS NULL OR length(flow_body) BETWEEN 1 AND 8000),
  flow_template_id      BIGINT,
  flow_started_at       TIMESTAMPTZ,

  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT telegram_post_preferences_flow_coherent CHECK (
    (flow_kind IS NULL AND flow_started_at IS NULL AND flow_name IS NULL AND flow_body IS NULL AND flow_template_id IS NULL)
    OR (flow_kind IS NOT NULL AND flow_started_at IS NOT NULL)
  ),
  -- The name step knows no body yet; the body steps must have their target. Making this explicit stops a
  -- handler from resuming a flow it cannot finish.
  CONSTRAINT telegram_post_preferences_flow_stage CHECK (
    flow_kind IS NULL
    OR (flow_kind = 'tpl_new_name' AND flow_body IS NULL AND flow_template_id IS NULL)
    OR (flow_kind = 'tpl_new_body' AND flow_name IS NOT NULL AND flow_template_id IS NULL)
    OR (flow_kind = 'tpl_edit_body' AND flow_template_id IS NOT NULL)
    OR (flow_kind = 'banner_title' AND flow_name IS NULL AND flow_body IS NULL AND flow_template_id IS NULL)
  )
);

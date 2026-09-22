-- ═══════════════════════════════════════════════════════════════════════════════
-- VELORA — MODERN TARGET SCHEMA · consolidated DDL snapshot
-- Generated from a live PGlite (PostgreSQL 16 semantics) run of db/migrations/
-- Migrations applied: 22 (0001_core.sql … 0022_legacy_contract_parity.sql)
-- Tables: 37 application tables (schema_migrations omitted)
--
-- ⚠ This file is a GENERATED SNAPSHOT for archival/review. The migration files in
--   db/migrations/ remain the single source of truth (ADR-010, forward-only).
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE account_group_members (
  group_id bigint NOT NULL,
  account_id bigint NOT NULL,
  user_id bigint NOT NULL,
  added_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT account_group_members_pkey PRIMARY KEY (group_id, account_id)
);
CREATE INDEX account_group_members_account_idx ON public.account_group_members USING btree (account_id);

CREATE TABLE account_groups (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  name text NOT NULL,
  description text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT account_groups_description_check CHECK (((description IS NULL) OR (length(description) <= 500))),
  CONSTRAINT account_groups_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
  CONSTRAINT account_groups_pkey PRIMARY KEY (id),
  CONSTRAINT account_groups_user_name_unique UNIQUE (user_id, name)
);

CREATE TABLE account_performance_summary (
  account_id bigint NOT NULL,
  user_id bigint NOT NULL,
  currency text,
  as_of timestamp with time zone DEFAULT now() NOT NULL,
  trades_count integer DEFAULT 0 NOT NULL,
  wins integer DEFAULT 0 NOT NULL,
  losses integer DEFAULT 0 NOT NULL,
  breakeven integer DEFAULT 0 NOT NULL,
  gross_profit numeric(20,2) DEFAULT 0.00 NOT NULL,
  gross_loss numeric(20,2) DEFAULT 0.00 NOT NULL,
  net_pnl numeric(20,2) DEFAULT 0.00 NOT NULL,
  win_rate numeric(18,8),
  profit_factor numeric(18,8),
  expectancy numeric(20,2),
  max_drawdown numeric(20,2),
  equity_peak numeric(20,2),
  equity_trough numeric(20,2),
  CONSTRAINT account_performance_summary_breakeven_check CHECK ((breakeven >= 0)),
  CONSTRAINT account_performance_summary_currency_check CHECK (((currency IS NULL) OR (currency ~ '^[A-Z]{3}$'::text))),
  CONSTRAINT account_performance_summary_gross_loss_check CHECK ((gross_loss <= (0)::numeric)),
  CONSTRAINT account_performance_summary_gross_profit_check CHECK ((gross_profit >= (0)::numeric)),
  CONSTRAINT account_performance_summary_losses_check CHECK ((losses >= 0)),
  CONSTRAINT account_performance_summary_max_drawdown_check CHECK (((max_drawdown IS NULL) OR (max_drawdown >= (0)::numeric))),
  CONSTRAINT account_performance_summary_trades_count_check CHECK ((trades_count >= 0)),
  CONSTRAINT account_performance_summary_wins_check CHECK ((wins >= 0)),
  CONSTRAINT account_performance_summary_pkey PRIMARY KEY (account_id)
);
CREATE INDEX account_performance_summary_user_idx ON public.account_performance_summary USING btree (user_id, as_of DESC);

CREATE TABLE ai_coaching_logs (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  window_from timestamp with time zone,
  window_to timestamp with time zone,
  trades_analyzed integer,
  insight jsonb NOT NULL,
  tokens_in integer,
  tokens_out integer,
  cost_micro_usd bigint,
  outcome text NOT NULL,
  error_code text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ai_coaching_logs_cost_micro_usd_check CHECK (((cost_micro_usd IS NULL) OR (cost_micro_usd >= 0))),
  CONSTRAINT ai_coaching_logs_error_code_check CHECK (((error_code IS NULL) OR (error_code ~ '^[A-Z0-9_]{1,48}$'::text))),
  CONSTRAINT ai_coaching_logs_insight_check CHECK ((jsonb_typeof(insight) = 'object'::text)),
  CONSTRAINT ai_coaching_logs_model_check CHECK (((length(btrim(model)) >= 1) AND (length(btrim(model)) <= 120))),
  CONSTRAINT ai_coaching_logs_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'refused'::text, 'error'::text]))),
  CONSTRAINT ai_coaching_logs_prompt_version_check CHECK (((length(btrim(prompt_version)) >= 1) AND (length(btrim(prompt_version)) <= 40))),
  CONSTRAINT ai_coaching_logs_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'gemini'::text]))),
  CONSTRAINT ai_coaching_logs_tokens_in_check CHECK (((tokens_in IS NULL) OR (tokens_in >= 0))),
  CONSTRAINT ai_coaching_logs_tokens_out_check CHECK (((tokens_out IS NULL) OR (tokens_out >= 0))),
  CONSTRAINT ai_coaching_logs_trades_analyzed_check CHECK (((trades_analyzed IS NULL) OR (trades_analyzed >= 0))),
  CONSTRAINT ai_coaching_logs_window_sane CHECK (((window_from IS NULL) OR (window_to IS NULL) OR (window_from <= window_to))),
  CONSTRAINT ai_coaching_logs_pkey PRIMARY KEY (id)
);
CREATE INDEX ai_coaching_logs_user_idx ON public.ai_coaching_logs USING btree (user_id, created_at DESC);

CREATE TABLE audit_log (
  id bigint NOT NULL,
  occurred_at timestamp with time zone DEFAULT now() NOT NULL,
  action text NOT NULL,
  actor_user_id bigint NOT NULL,
  target_user_id bigint,
  before_state text,
  after_state text,
  outcome text DEFAULT 'success'::text NOT NULL,
  request_id text,
  credential_id bigint,
  provider text,
  trading_account_id bigint,
  CONSTRAINT audit_log_action_check CHECK ((action = ANY (ARRAY['OWNERSHIP_CLAIMED'::text, 'USER_ROLE_CHANGED'::text, 'USER_STATUS_CHANGED'::text, 'CREDENTIAL_CREATED'::text, 'CREDENTIAL_DELETED'::text, 'CREDENTIAL_USED'::text, 'ACCOUNT_BINDING_CHANGED'::text]))),
  CONSTRAINT audit_log_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'denied'::text]))),
  CONSTRAINT audit_log_provider_check CHECK (((provider IS NULL) OR (provider = 'METAAPI'::text))),
  CONSTRAINT audit_log_pkey PRIMARY KEY (id)
);
CREATE INDEX audit_log_occurred_idx ON public.audit_log USING btree (occurred_at DESC, id DESC);
CREATE INDEX audit_log_target_idx ON public.audit_log USING btree (target_user_id, occurred_at DESC);
CREATE INDEX audit_log_trading_account_idx ON public.audit_log USING btree (trading_account_id, occurred_at DESC) WHERE (trading_account_id IS NOT NULL);

CREATE TABLE copy_relationships (
  id bigint NOT NULL,
  leader_user_id bigint NOT NULL,
  follower_user_id bigint NOT NULL,
  leader_account_id bigint NOT NULL,
  follower_account_id bigint NOT NULL,
  allocation_mode text DEFAULT 'proportional'::text NOT NULL,
  allocation_value numeric(20,8) DEFAULT 1.00000000 NOT NULL,
  max_lot_per_signal numeric(20,8),
  status text DEFAULT 'pending'::text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT copy_relationships_allocation_mode_check CHECK ((allocation_mode = ANY (ARRAY['fixed_lot'::text, 'proportional'::text, 'risk_multiplier'::text]))),
  CONSTRAINT copy_relationships_allocation_value_check CHECK ((allocation_value > (0)::numeric)),
  CONSTRAINT copy_relationships_max_lot_per_signal_check CHECK (((max_lot_per_signal IS NULL) OR (max_lot_per_signal > (0)::numeric))),
  CONSTRAINT copy_relationships_not_self CHECK ((leader_user_id <> follower_user_id)),
  CONSTRAINT copy_relationships_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'active'::text, 'paused'::text, 'revoked'::text]))),
  CONSTRAINT copy_relationships_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX copy_relationships_pair_unique ON public.copy_relationships USING btree (leader_account_id, follower_account_id) WHERE (status = ANY (ARRAY['pending'::text, 'active'::text, 'paused'::text]));

CREATE TABLE currency_rates (
  base text NOT NULL,
  quote text NOT NULL,
  rate_date date NOT NULL,
  rate numeric(24,10) NOT NULL,
  source text DEFAULT 'ECB'::text NOT NULL,
  fetched_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT currency_rates_base_check CHECK ((base ~ '^[A-Z]{3}$'::text)),
  CONSTRAINT currency_rates_distinct_pair CHECK ((base <> quote)),
  CONSTRAINT currency_rates_quote_check CHECK ((quote ~ '^[A-Z]{3}$'::text)),
  CONSTRAINT currency_rates_rate_check CHECK ((rate > (0)::numeric)),
  CONSTRAINT currency_rates_source_check CHECK (((length(btrim(source)) >= 1) AND (length(btrim(source)) <= 40))),
  CONSTRAINT currency_rates_pkey PRIMARY KEY (base, quote, rate_date)
);
CREATE INDEX currency_rates_lookup_idx ON public.currency_rates USING btree (base, quote, rate_date DESC);

CREATE TABLE developer_api_keys (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL,
  scopes text[] DEFAULT ARRAY['trades:read'::text] NOT NULL,
  rate_limit_per_min integer DEFAULT 100 NOT NULL,
  last_used_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT developer_api_keys_key_hash_check CHECK ((key_hash ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT developer_api_keys_key_prefix_check CHECK ((key_prefix ~ '^[A-Za-z0-9]{6,12}$'::text)),
  CONSTRAINT developer_api_keys_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 120))),
  CONSTRAINT developer_api_keys_rate_limit_per_min_check CHECK (((rate_limit_per_min >= 1) AND (rate_limit_per_min <= 10000))),
  CONSTRAINT developer_api_keys_scopes_check CHECK ((scopes <@ ARRAY['trades:read'::text, 'trades:write'::text, 'analytics:read'::text, 'accounts:read'::text])),
  CONSTRAINT developer_api_keys_pkey PRIMARY KEY (id),
  CONSTRAINT developer_api_keys_hash_unique UNIQUE (key_hash)
);
CREATE INDEX developer_api_keys_user_live_idx ON public.developer_api_keys USING btree (user_id) WHERE (revoked_at IS NULL);

CREATE TABLE device_tokens (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  platform text NOT NULL,
  token_fingerprint text NOT NULL,
  enc_version smallint DEFAULT 1 NOT NULL,
  key_version smallint NOT NULL,
  algorithm text DEFAULT 'aes-256-gcm'::text NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  token_ciphertext bytea NOT NULL,
  registered_at timestamp with time zone DEFAULT now() NOT NULL,
  last_used_at timestamp with time zone,
  revoked_at timestamp with time zone,
  CONSTRAINT device_tokens_algorithm_check CHECK ((algorithm = 'aes-256-gcm'::text)),
  CONSTRAINT device_tokens_auth_tag_check CHECK ((octet_length(auth_tag) = 16)),
  CONSTRAINT device_tokens_enc_version_check CHECK ((enc_version = 1)),
  CONSTRAINT device_tokens_iv_check CHECK ((octet_length(iv) = 12)),
  CONSTRAINT device_tokens_key_version_check CHECK ((key_version >= 1)),
  CONSTRAINT device_tokens_platform_check CHECK ((platform = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text]))),
  CONSTRAINT device_tokens_token_ciphertext_check CHECK ((octet_length(token_ciphertext) > 0)),
  CONSTRAINT device_tokens_token_fingerprint_check CHECK ((token_fingerprint ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT device_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT device_tokens_fingerprint_unique UNIQUE (token_fingerprint),
  CONSTRAINT device_tokens_nonce_unique UNIQUE (key_version, iv)
);
CREATE INDEX device_tokens_user_live_idx ON public.device_tokens USING btree (user_id) WHERE (revoked_at IS NULL);

CREATE TABLE email_preferences (
  user_id bigint NOT NULL,
  welcome_email boolean DEFAULT true NOT NULL,
  security_alerts boolean DEFAULT true NOT NULL,
  trade_notifications boolean DEFAULT true NOT NULL,
  weekly_report boolean DEFAULT true NOT NULL,
  monthly_report boolean DEFAULT true NOT NULL,
  achievement_notifications boolean DEFAULT true NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT email_preferences_pkey PRIMARY KEY (user_id)
);

CREATE TABLE email_verifications (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT email_verifications_pkey PRIMARY KEY (id),
  CONSTRAINT email_verifications_token_unique UNIQUE (token_hash)
);

CREATE TABLE installation_ownership (
  id boolean DEFAULT true NOT NULL,
  owner_user_id bigint NOT NULL,
  claimed_by_user_id bigint NOT NULL,
  claimed_at timestamp with time zone DEFAULT now() NOT NULL,
  claimed_ip text,
  claimed_user_agent text,
  CONSTRAINT installation_ownership_id_check CHECK ((id = true)),
  CONSTRAINT installation_ownership_pkey PRIMARY KEY (id)
);

CREATE TABLE ml_model_predictions (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  trade_id bigint,
  model_name text NOT NULL,
  model_version text NOT NULL,
  features jsonb NOT NULL,
  prediction jsonb NOT NULL,
  probability numeric(6,5),
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT ml_model_predictions_features_check CHECK ((jsonb_typeof(features) = 'object'::text)),
  CONSTRAINT ml_model_predictions_model_name_check CHECK (((length(btrim(model_name)) >= 1) AND (length(btrim(model_name)) <= 120))),
  CONSTRAINT ml_model_predictions_model_version_check CHECK (((length(btrim(model_version)) >= 1) AND (length(btrim(model_version)) <= 60))),
  CONSTRAINT ml_model_predictions_prediction_check CHECK ((jsonb_typeof(prediction) = 'object'::text)),
  CONSTRAINT ml_model_predictions_probability_check CHECK (((probability IS NULL) OR ((probability >= (0)::numeric) AND (probability <= (1)::numeric)))),
  CONSTRAINT ml_model_predictions_pkey PRIMARY KEY (id)
);
CREATE INDEX ml_model_predictions_user_idx ON public.ml_model_predictions USING btree (user_id, created_at DESC);
CREATE INDEX ml_model_predictions_trade_idx ON public.ml_model_predictions USING btree (trade_id) WHERE (trade_id IS NOT NULL);

CREATE TABLE password_resets (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  token_hash text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  consumed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT password_resets_pkey PRIMARY KEY (id),
  CONSTRAINT password_resets_token_unique UNIQUE (token_hash)
);

CREATE TABLE prop_firm_rules (
  id bigint NOT NULL,
  account_id bigint NOT NULL,
  user_id bigint NOT NULL,
  rule_set_name text DEFAULT 'default'::text NOT NULL,
  max_daily_drawdown numeric(20,2),
  max_total_drawdown numeric(20,2),
  profit_target numeric(20,2),
  drawdown_basis text DEFAULT 'balance'::text NOT NULL,
  daily_reset_time time without time zone,
  daily_reset_tz text,
  alert_threshold_pct numeric(5,2) DEFAULT 80.00 NOT NULL,
  enabled boolean DEFAULT true NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT prop_firm_rules_alert_threshold_pct_check CHECK (((alert_threshold_pct > (0)::numeric) AND (alert_threshold_pct <= (100)::numeric))),
  CONSTRAINT prop_firm_rules_daily_reset_tz_check CHECK (((daily_reset_tz IS NULL) OR ((length(daily_reset_tz) >= 1) AND (length(daily_reset_tz) <= 64)))),
  CONSTRAINT prop_firm_rules_drawdown_basis_check CHECK ((drawdown_basis = ANY (ARRAY['balance'::text, 'equity'::text]))),
  CONSTRAINT prop_firm_rules_max_daily_drawdown_check CHECK (((max_daily_drawdown IS NULL) OR (max_daily_drawdown > (0)::numeric))),
  CONSTRAINT prop_firm_rules_max_total_drawdown_check CHECK (((max_total_drawdown IS NULL) OR (max_total_drawdown > (0)::numeric))),
  CONSTRAINT prop_firm_rules_profit_target_check CHECK (((profit_target IS NULL) OR (profit_target > (0)::numeric))),
  CONSTRAINT prop_firm_rules_rule_set_name_check CHECK (((length(btrim(rule_set_name)) >= 1) AND (length(btrim(rule_set_name)) <= 120))),
  CONSTRAINT prop_firm_rules_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX prop_firm_rules_one_per_account ON public.prop_firm_rules USING btree (account_id) WHERE enabled;

CREATE TABLE provisioning_operations (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  account_id bigint NOT NULL,
  operation_key text NOT NULL,
  provider_marker text NOT NULL,
  transaction_id text,
  status text DEFAULT 'PENDING'::text NOT NULL,
  provider_account_id text,
  last_error_code text,
  attempts integer DEFAULT 0 NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT provisioning_operations_attempts_check CHECK ((attempts >= 0)),
  CONSTRAINT provisioning_operations_last_error_code_check CHECK (((last_error_code IS NULL) OR (last_error_code ~ '^[A-Z_]{1,40}$'::text))),
  CONSTRAINT provisioning_operations_operation_key_check CHECK ((operation_key ~ '^[a-f0-9]{64}$'::text)),
  CONSTRAINT provisioning_operations_provider_account_id_check CHECK (((provider_account_id IS NULL) OR (provider_account_id ~ '^[A-Za-z0-9._:-]{1,64}$'::text))),
  CONSTRAINT provisioning_operations_provider_marker_check CHECK ((provider_marker ~ '^velora-[a-f0-9]{32}$'::text)),
  CONSTRAINT provisioning_operations_status_check CHECK ((status = ANY (ARRAY['PENDING'::text, 'ACCEPTED'::text, 'COMPLETED'::text, 'AMBIGUOUS'::text, 'FAILED'::text]))),
  CONSTRAINT provisioning_operations_transaction_id_check CHECK (((transaction_id IS NULL) OR (transaction_id ~ '^[A-Za-z0-9]{32}$'::text))),
  CONSTRAINT provisioning_operations_pkey PRIMARY KEY (id),
  CONSTRAINT provisioning_operations_key_unique UNIQUE (user_id, operation_key),
  CONSTRAINT provisioning_operations_marker_unique UNIQUE (provider_marker)
);
CREATE INDEX provisioning_operations_unresolved_idx ON public.provisioning_operations USING btree (status, updated_at) WHERE (status = ANY (ARRAY['PENDING'::text, 'ACCEPTED'::text, 'AMBIGUOUS'::text]));

CREATE TABLE public_profiles (
  user_id bigint NOT NULL,
  handle text NOT NULL,
  visibility text DEFAULT 'private'::text NOT NULL,
  show_absolute_amounts boolean DEFAULT false NOT NULL,
  verified_at timestamp with time zone,
  verification_hash text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT public_profiles_handle_check CHECK ((handle ~ '^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$'::text)),
  CONSTRAINT public_profiles_verification_hash_check CHECK (((verification_hash IS NULL) OR (verification_hash ~ '^[0-9a-f]{64}$'::text))),
  CONSTRAINT public_profiles_verification_pair CHECK (((verified_at IS NULL) = (verification_hash IS NULL))),
  CONSTRAINT public_profiles_visibility_check CHECK ((visibility = ANY (ARRAY['private'::text, 'link'::text, 'public'::text]))),
  CONSTRAINT public_profiles_pkey PRIMARY KEY (user_id),
  CONSTRAINT public_profiles_handle_unique UNIQUE (handle)
);

CREATE TABLE rate_limits (
  bucket text NOT NULL,
  hits bigint DEFAULT 1 NOT NULL,
  window_start timestamp with time zone NOT NULL,
  CONSTRAINT rate_limits_pkey PRIMARY KEY (bucket)
);

CREATE TABLE signal_queue (
  id bigint NOT NULL,
  leader_account_id bigint NOT NULL,
  leader_user_id bigint NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  volume numeric(20,8) NOT NULL,
  price numeric(20,8) NOT NULL,
  occurred_at timestamp with time zone NOT NULL,
  status text DEFAULT 'queued'::text NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  lease_expires_at timestamp with time zone,
  last_error_code text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  acked_at timestamp with time zone,
  CONSTRAINT signal_queue_ack_coherent CHECK (((status = 'acked'::text) = (acked_at IS NOT NULL))),
  CONSTRAINT signal_queue_attempts_check CHECK ((attempts >= 0)),
  CONSTRAINT signal_queue_direction_check CHECK ((direction = ANY (ARRAY['buy'::text, 'sell'::text]))),
  CONSTRAINT signal_queue_last_error_code_check CHECK (((last_error_code IS NULL) OR (last_error_code ~ '^[A-Z0-9_]{1,48}$'::text))),
  CONSTRAINT signal_queue_price_check CHECK ((price > (0)::numeric)),
  CONSTRAINT signal_queue_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'dispatched'::text, 'acked'::text, 'failed'::text, 'expired'::text]))),
  CONSTRAINT signal_queue_symbol_check CHECK (((length(btrim(symbol)) >= 1) AND (length(btrim(symbol)) <= 32))),
  CONSTRAINT signal_queue_volume_check CHECK ((volume > (0)::numeric)),
  CONSTRAINT signal_queue_pkey PRIMARY KEY (id)
);
CREATE INDEX signal_queue_dispatch_idx ON public.signal_queue USING btree (status, created_at) WHERE (status = ANY (ARRAY['queued'::text, 'dispatched'::text]));
CREATE INDEX signal_queue_leader_idx ON public.signal_queue USING btree (leader_account_id, created_at DESC);

CREATE TABLE subscriptions (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  plan text NOT NULL,
  status text NOT NULL,
  provider text DEFAULT 'stripe'::text NOT NULL,
  provider_customer_id text,
  provider_subscription_id text,
  current_period_start timestamp with time zone,
  current_period_end timestamp with time zone,
  cancel_at_period_end boolean DEFAULT false NOT NULL,
  canceled_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT subscriptions_plan_check CHECK ((plan = ANY (ARRAY['pro'::text, 'enterprise'::text]))),
  CONSTRAINT subscriptions_provider_check CHECK ((provider = 'stripe'::text)),
  CONSTRAINT subscriptions_status_check CHECK ((status = ANY (ARRAY['incomplete'::text, 'trialing'::text, 'active'::text, 'past_due'::text, 'canceled'::text, 'unpaid'::text]))),
  CONSTRAINT subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT subscriptions_provider_unique UNIQUE (provider, provider_subscription_id)
);
CREATE UNIQUE INDEX subscriptions_one_live_per_user ON public.subscriptions USING btree (user_id) WHERE (status = ANY (ARRAY['active'::text, 'trialing'::text, 'past_due'::text]));
CREATE INDEX subscriptions_user_recent_idx ON public.subscriptions USING btree (user_id, created_at DESC);

CREATE TABLE sync_fills (
  id bigint NOT NULL,
  account_id bigint NOT NULL,
  user_id bigint NOT NULL,
  external_deal_id text NOT NULL,
  position_id text,
  entry_type text,
  direction text,
  symbol text,
  volume numeric(20,8),
  price numeric(20,8),
  profit numeric(20,2),
  commission numeric(20,2),
  swap numeric(20,2),
  occurred_at_utc timestamp with time zone,
  raw_time_text text,
  time_status text DEFAULT 'unresolved'::text NOT NULL,
  ingestion_source text DEFAULT 'historical'::text NOT NULL,
  processing_state text DEFAULT 'received'::text NOT NULL,
  processed_trade_id bigint,
  skip_reason text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  broker_time_text text,
  CONSTRAINT sync_fills_direction_check CHECK (((direction IS NULL) OR (direction = ANY (ARRAY['buy'::text, 'sell'::text])))),
  CONSTRAINT sync_fills_entry_type_check CHECK (((entry_type IS NULL) OR (entry_type = ANY (ARRAY['in'::text, 'out'::text])))),
  CONSTRAINT sync_fills_ingestion_source_check CHECK ((ingestion_source = ANY (ARRAY['historical'::text, 'incremental'::text, 'webhook'::text]))),
  CONSTRAINT sync_fills_processing_state_check CHECK ((processing_state = ANY (ARRAY['received'::text, 'aggregated'::text, 'skipped'::text, 'rejected'::text]))),
  CONSTRAINT sync_fills_skip_reason_check CHECK (((skip_reason IS NULL) OR (skip_reason ~ '^[A-Z0-9_]{1,48}$'::text))),
  CONSTRAINT sync_fills_time_consistency CHECK ((((time_status = 'resolved_utc'::text) AND (occurred_at_utc IS NOT NULL)) OR ((time_status = 'unresolved'::text) AND (occurred_at_utc IS NULL)))),
  CONSTRAINT sync_fills_time_status_check CHECK ((time_status = ANY (ARRAY['resolved_utc'::text, 'unresolved'::text]))),
  CONSTRAINT sync_fills_pkey PRIMARY KEY (id),
  CONSTRAINT sync_fills_deal_unique UNIQUE (account_id, external_deal_id)
);
CREATE INDEX sync_fills_position_idx ON public.sync_fills USING btree (account_id, position_id, processing_state);
CREATE INDEX sync_fills_user_idx ON public.sync_fills USING btree (user_id, created_at DESC);

CREATE TABLE sync_reservations (
  id bigint NOT NULL,
  account_id bigint NOT NULL,
  user_id bigint NOT NULL,
  operation text DEFAULT 'HISTORICAL'::text NOT NULL,
  holder text NOT NULL,
  lease_expires_at timestamp with time zone NOT NULL,
  acquired_at timestamp with time zone DEFAULT now() NOT NULL,
  released_at timestamp with time zone,
  stale_reclaimed boolean DEFAULT false NOT NULL,
  CONSTRAINT sync_reservations_lease_after_acquire CHECK ((lease_expires_at > acquired_at)),
  CONSTRAINT sync_reservations_operation_check CHECK ((operation = ANY (ARRAY['HISTORICAL'::text, 'INCREMENTAL'::text, 'WEBHOOK'::text]))),
  CONSTRAINT sync_reservations_release_order CHECK (((released_at IS NULL) OR (released_at >= acquired_at))),
  CONSTRAINT sync_reservations_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX sync_reservations_one_active_per_account ON public.sync_reservations USING btree (account_id) WHERE (released_at IS NULL);
CREATE INDEX sync_reservations_expiry_idx ON public.sync_reservations USING btree (lease_expires_at) WHERE (released_at IS NULL);

CREATE TABLE tags (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  name text NOT NULL,
  kind text DEFAULT 'CUSTOM'::text NOT NULL,
  color text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT tags_color_check CHECK (((color IS NULL) OR (color ~ '^#[0-9A-Fa-f]{6}$'::text))),
  CONSTRAINT tags_kind_check CHECK ((kind = ANY (ARRAY['STRATEGY'::text, 'SETUP'::text, 'MISTAKE'::text, 'EMOTION'::text, 'CUSTOM'::text]))),
  CONSTRAINT tags_name_check CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 60))),
  CONSTRAINT tags_pkey PRIMARY KEY (id),
  CONSTRAINT tags_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT tags_user_name_unique UNIQUE (user_id, name)
);
CREATE INDEX tags_user_kind_idx ON public.tags USING btree (user_id, kind, name);

CREATE TABLE tenants (
  id bigint NOT NULL,
  slug text NOT NULL,
  display_name text NOT NULL,
  branding jsonb DEFAULT '{}'::jsonb NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  owner_user_id bigint,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT tenants_branding_check CHECK ((jsonb_typeof(branding) = 'object'::text)),
  CONSTRAINT tenants_display_name_check CHECK (((length(btrim(display_name)) >= 1) AND (length(btrim(display_name)) <= 120))),
  CONSTRAINT tenants_slug_check CHECK ((slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'::text)),
  CONSTRAINT tenants_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text]))),
  CONSTRAINT tenants_pkey PRIMARY KEY (id),
  CONSTRAINT tenants_slug_unique UNIQUE (slug)
);

CREATE TABLE trade_attachments (
  id bigint NOT NULL,
  trade_id bigint NOT NULL,
  user_id bigint NOT NULL,
  category text DEFAULT 'OTHER'::text NOT NULL,
  file_name text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  storage_key text NOT NULL,
  checksum_sha256 text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  deleted_at timestamp with time zone,
  CONSTRAINT trade_attachments_category_check CHECK ((category = ANY (ARRAY['BEFORE'::text, 'AFTER'::text, 'OTHER'::text]))),
  CONSTRAINT trade_attachments_checksum_sha256_check CHECK (((checksum_sha256 IS NULL) OR (checksum_sha256 ~ '^[0-9a-f]{64}$'::text))),
  CONSTRAINT trade_attachments_file_name_check CHECK (((length(btrim(file_name)) >= 1) AND (length(btrim(file_name)) <= 255))),
  CONSTRAINT trade_attachments_mime_check CHECK ((mime = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text]))),
  CONSTRAINT trade_attachments_size_bytes_check CHECK (((size_bytes > 0) AND (size_bytes <= 5242880))),
  CONSTRAINT trade_attachments_storage_key_check CHECK (((length(storage_key) >= 1) AND (length(storage_key) <= 512))),
  CONSTRAINT trade_attachments_pkey PRIMARY KEY (id),
  CONSTRAINT trade_attachments_storage_unique UNIQUE (storage_key)
);
CREATE INDEX trade_attachments_trade_idx ON public.trade_attachments USING btree (trade_id, category) WHERE (deleted_at IS NULL);

CREATE TABLE trade_events (
  id bigint NOT NULL,
  event_uid text NOT NULL,
  trade_id bigint NOT NULL,
  type text NOT NULL,
  actor text NOT NULL,
  expected_version bigint NOT NULL,
  payload jsonb NOT NULL,
  at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT trade_events_actor_check CHECK ((actor = ANY (ARRAY['user'::text, 'sync'::text, 'webhook'::text, 'admin'::text, 'system'::text]))),
  CONSTRAINT trade_events_type_check CHECK ((type = ANY (ARRAY['TRADE_IMPORTED'::text, 'TRADE_CREATED'::text, 'FINANCIAL_CORRECTED'::text, 'JOURNALING_EDITED'::text, 'EXIT_RECORDED'::text, 'EXIT_CANCELLED'::text, 'TOMBSTONE_SET'::text, 'ADMIN_CORRECTION'::text, 'QUARANTINE_RAISED'::text]))),
  CONSTRAINT trade_events_pkey PRIMARY KEY (id),
  CONSTRAINT trade_events_uid_unique UNIQUE (event_uid)
);
CREATE INDEX trade_events_trade_idx ON public.trade_events USING btree (trade_id, id);

CREATE TABLE trade_exits (
  id bigint NOT NULL,
  trade_id bigint NOT NULL,
  volume numeric(20,8) NOT NULL,
  price numeric(20,8) NOT NULL,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  exit_type text DEFAULT 'manual'::text NOT NULL,
  pnl numeric(20,2),
  notes text,
  exited_at timestamp with time zone,
  deleted_at timestamp with time zone,
  CONSTRAINT trade_exits_exit_type_check CHECK ((exit_type = ANY (ARRAY['tp'::text, 'sl'::text, 'manual'::text, 'partial'::text]))),
  CONSTRAINT trade_exits_volume_check CHECK ((volume > (0)::numeric)),
  CONSTRAINT trade_exits_pkey PRIMARY KEY (id)
);
CREATE INDEX trade_exits_trade_idx ON public.trade_exits USING btree (trade_id, exited_at) WHERE (deleted_at IS NULL);

CREATE TABLE trade_tags (
  trade_id bigint NOT NULL,
  tag_id bigint NOT NULL,
  user_id bigint NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT trade_tags_pkey PRIMARY KEY (trade_id, tag_id)
);
CREATE INDEX trade_tags_tag_idx ON public.trade_tags USING btree (tag_id, trade_id);

CREATE TABLE trades (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  account_id bigint,
  external_deal_id text,
  ticket_id text,
  symbol text NOT NULL,
  direction text NOT NULL,
  status text DEFAULT 'CLOSED'::text NOT NULL,
  entry_price numeric(20,8) NOT NULL,
  exit_price numeric(20,8),
  volume numeric(20,8) NOT NULL,
  contract_size numeric(20,8) DEFAULT 1.00000000 NOT NULL,
  commission numeric(20,2) DEFAULT 0.00 NOT NULL,
  swap numeric(20,2) DEFAULT 0.00 NOT NULL,
  net_pnl numeric(20,2),
  r_multiple numeric(20,8),
  stop_loss numeric(20,8),
  take_profit numeric(20,8),
  strategy text,
  setup text,
  emotion text,
  notes text,
  allocated_volume numeric(20,8) DEFAULT 0.00000000 NOT NULL,
  version bigint DEFAULT 0 NOT NULL,
  deleted_at timestamp with time zone,
  occurred_at timestamp with time zone NOT NULL,
  source_time_naive text,
  source_tz_offset text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  occurred_open_at_utc timestamp with time zone,
  occurred_close_at_utc timestamp with time zone,
  time_status text DEFAULT 'unresolved'::text NOT NULL,
  source_timezone text,
  source_timezone_source text DEFAULT 'unknown'::text NOT NULL,
  source_calendar text DEFAULT 'unknown'::text NOT NULL,
  raw_open_text text,
  raw_close_text text,
  source text DEFAULT 'manual'::text NOT NULL,
  quarantined boolean DEFAULT false NOT NULL,
  strategy_tag text,
  emotional_score smallint,
  confidence smallint,
  mistake text,
  market_context text,
  lot_size numeric(20,8),
  CONSTRAINT trades_allocation_guard CHECK ((allocated_volume <= volume)),
  CONSTRAINT trades_confidence_check CHECK (((confidence IS NULL) OR ((confidence >= 0) AND (confidence <= 255)))),
  CONSTRAINT trades_direction_check CHECK ((direction = ANY (ARRAY['buy'::text, 'sell'::text]))),
  CONSTRAINT trades_emotional_score_check CHECK (((emotional_score IS NULL) OR ((emotional_score >= 0) AND (emotional_score <= 255)))),
  CONSTRAINT trades_lot_size_check CHECK (((lot_size IS NULL) OR (lot_size >= (0)::numeric))),
  CONSTRAINT trades_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'metaapi'::text, 'import'::text]))),
  CONSTRAINT trades_status_check CHECK ((status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text]))),
  CONSTRAINT trades_time_status_check CHECK ((time_status = ANY (ARRAY['resolved'::text, 'unresolved'::text]))),
  CONSTRAINT trades_volume_positive CHECK ((volume > (0)::numeric)),
  CONSTRAINT trades_pkey PRIMARY KEY (id),
  CONSTRAINT trades_extdeal_unique UNIQUE (account_id, external_deal_id),
  CONSTRAINT trades_id_user_unique UNIQUE (id, user_id)
);
CREATE INDEX trades_user_idx ON public.trades USING btree (user_id, occurred_at DESC);
CREATE INDEX trades_account_idx ON public.trades USING btree (account_id);
CREATE INDEX trades_user_open_idx ON public.trades USING btree (user_id, occurred_open_at_utc DESC) WHERE (deleted_at IS NULL);
CREATE INDEX trades_quarantined_idx ON public.trades USING btree (user_id, id) WHERE quarantined;
CREATE INDEX trades_account_open_canonical_idx ON public.trades USING btree (account_id, occurred_open_at_utc DESC) WHERE (deleted_at IS NULL);
CREATE INDEX trades_account_symbol_idx ON public.trades USING btree (account_id, symbol) WHERE (deleted_at IS NULL);
CREATE INDEX trades_user_strategy_tag_idx ON public.trades USING btree (user_id, strategy_tag) WHERE ((strategy_tag IS NOT NULL) AND (deleted_at IS NULL));

CREATE TABLE trading_accounts (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  external_account_id text,
  broker_server text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  provider text DEFAULT 'MANUAL'::text NOT NULL,
  platform text DEFAULT 'MANUAL'::text NOT NULL,
  label text DEFAULT 'Trading Account'::text NOT NULL,
  account_number_masked text DEFAULT ''::text NOT NULL,
  currency text DEFAULT 'USD'::text NOT NULL,
  leverage text DEFAULT '100'::text NOT NULL,
  timezone text,
  timezone_source text DEFAULT 'unknown'::text NOT NULL,
  status text DEFAULT 'disconnected'::text NOT NULL,
  sync_status text DEFAULT 'DISCONNECTED'::text NOT NULL,
  balance numeric(20,2) DEFAULT 0.00 NOT NULL,
  equity numeric(20,2) DEFAULT 0.00 NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  last_synced_at timestamp with time zone,
  sync_cursor text,
  last_sync_error_code text,
  metaapi_account_id text,
  ea_api_key_hash text,
  ea_key_created_at timestamp with time zone,
  ea_key_rotated_at timestamp with time zone,
  ea_key_revoked_at timestamp with time zone,
  ea_last_seen_at timestamp with time zone,
  starting_balance numeric(20,2) DEFAULT 0.00 NOT NULL,
  account_type text DEFAULT 'STANDARD'::text NOT NULL,
  auto_sync_enabled boolean DEFAULT true NOT NULL,
  consecutive_errors integer DEFAULT 0 NOT NULL,
  last_error text,
  connected_at timestamp with time zone,
  disconnected_at timestamp with time zone,
  connection_checked_at timestamp with time zone,
  last_incremental_at timestamp with time zone,
  CONSTRAINT trading_accounts_consecutive_errors_check CHECK ((consecutive_errors >= 0)),
  CONSTRAINT trading_accounts_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text)),
  CONSTRAINT trading_accounts_ea_api_key_hash_check CHECK (((ea_api_key_hash IS NULL) OR (ea_api_key_hash ~ '^[0-9a-f]{64}$'::text))),
  CONSTRAINT trading_accounts_last_sync_error_code_check CHECK (((last_sync_error_code IS NULL) OR (last_sync_error_code ~ '^[A-Z0-9_]{1,48}$'::text))),
  CONSTRAINT trading_accounts_leverage_check CHECK ((leverage ~ '^(1:)?[1-9][0-9]{0,7}$'::text)),
  CONSTRAINT trading_accounts_metaapi_account_id_check CHECK (((metaapi_account_id IS NULL) OR (metaapi_account_id ~ '^[A-Za-z0-9._:-]{1,64}$'::text))),
  CONSTRAINT trading_accounts_provider_check CHECK ((provider = ANY (ARRAY['MT4'::text, 'MT5'::text, 'MANUAL'::text]))),
  CONSTRAINT trading_accounts_starting_balance_check CHECK ((starting_balance >= (0)::numeric)),
  CONSTRAINT trading_accounts_status_check CHECK ((status = ANY (ARRAY['connected'::text, 'error'::text, 'disconnected'::text]))),
  CONSTRAINT trading_accounts_sync_status_check CHECK ((sync_status = ANY (ARRAY['DISCONNECTED'::text, 'CONNECTING'::text, 'SYNCING'::text, 'CONNECTED'::text, 'ERROR'::text]))),
  CONSTRAINT trading_accounts_pkey PRIMARY KEY (id),
  CONSTRAINT trading_accounts_id_user_unique UNIQUE (id, user_id),
  CONSTRAINT trading_accounts_unique UNIQUE (user_id, external_account_id)
);
CREATE INDEX trading_accounts_user_recent_idx ON public.trading_accounts USING btree (user_id, created_at DESC);
CREATE UNIQUE INDEX trading_accounts_metaapi_unique ON public.trading_accounts USING btree (metaapi_account_id) WHERE (metaapi_account_id IS NOT NULL);
CREATE INDEX trading_accounts_sync_due_idx ON public.trading_accounts USING btree (last_synced_at NULLS FIRST) WHERE (metaapi_account_id IS NOT NULL);
CREATE UNIQUE INDEX trading_accounts_ea_key_unique ON public.trading_accounts USING btree (ea_api_key_hash) WHERE (ea_api_key_hash IS NOT NULL);
CREATE INDEX trading_accounts_ea_active_idx ON public.trading_accounts USING btree (ea_api_key_hash) WHERE ((ea_api_key_hash IS NOT NULL) AND (ea_key_revoked_at IS NULL));
CREATE INDEX trading_accounts_sync_errors_idx ON public.trading_accounts USING btree (user_id) WHERE (consecutive_errors > 0);

CREATE TABLE user_analytics_daily (
  user_id bigint NOT NULL,
  day date NOT NULL,
  tz_basis text NOT NULL,
  tz_basis_source text DEFAULT 'unknown'::text NOT NULL,
  trades_count integer DEFAULT 0 NOT NULL,
  wins integer DEFAULT 0 NOT NULL,
  losses integer DEFAULT 0 NOT NULL,
  breakeven integer DEFAULT 0 NOT NULL,
  gross_profit numeric(20,2) DEFAULT 0.00 NOT NULL,
  gross_loss numeric(20,2) DEFAULT 0.00 NOT NULL,
  net_pnl numeric(20,2) DEFAULT 0.00 NOT NULL,
  win_rate numeric(18,8),
  profit_factor numeric(18,8),
  expectancy numeric(20,2),
  max_drawdown numeric(20,2),
  computed_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT user_analytics_daily_breakeven_check CHECK ((breakeven >= 0)),
  CONSTRAINT user_analytics_daily_gross_loss_check CHECK ((gross_loss <= (0)::numeric)),
  CONSTRAINT user_analytics_daily_gross_profit_check CHECK ((gross_profit >= (0)::numeric)),
  CONSTRAINT user_analytics_daily_losses_check CHECK ((losses >= 0)),
  CONSTRAINT user_analytics_daily_max_drawdown_check CHECK (((max_drawdown IS NULL) OR (max_drawdown >= (0)::numeric))),
  CONSTRAINT user_analytics_daily_partition_consistent CHECK ((((wins + losses) + breakeven) <= trades_count)),
  CONSTRAINT user_analytics_daily_trades_count_check CHECK ((trades_count >= 0)),
  CONSTRAINT user_analytics_daily_tz_basis_check CHECK (((length(tz_basis) >= 1) AND (length(tz_basis) <= 64))),
  CONSTRAINT user_analytics_daily_tz_basis_source_check CHECK ((tz_basis_source = ANY (ARRAY['user_profile'::text, 'account'::text, 'broker'::text, 'assumed_utc'::text, 'unknown'::text]))),
  CONSTRAINT user_analytics_daily_wins_check CHECK ((wins >= 0)),
  CONSTRAINT user_analytics_daily_pkey PRIMARY KEY (user_id, day, tz_basis)
);
CREATE INDEX user_analytics_daily_user_day_idx ON public.user_analytics_daily USING btree (user_id, day DESC);

CREATE TABLE user_credentials (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  provider text NOT NULL,
  enc_version smallint DEFAULT 1 NOT NULL,
  key_version smallint NOT NULL,
  algorithm text DEFAULT 'aes-256-gcm'::text NOT NULL,
  iv bytea NOT NULL,
  auth_tag bytea NOT NULL,
  secret_ciphertext bytea NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT user_credentials_algorithm_check CHECK ((algorithm = 'aes-256-gcm'::text)),
  CONSTRAINT user_credentials_auth_tag_check CHECK ((octet_length(auth_tag) = 16)),
  CONSTRAINT user_credentials_enc_version_check CHECK ((enc_version = 1)),
  CONSTRAINT user_credentials_iv_check CHECK ((octet_length(iv) = 12)),
  CONSTRAINT user_credentials_key_version_check CHECK ((key_version >= 1)),
  CONSTRAINT user_credentials_provider_check CHECK ((provider = 'METAAPI'::text)),
  CONSTRAINT user_credentials_secret_ciphertext_check CHECK ((octet_length(secret_ciphertext) > 0)),
  CONSTRAINT user_credentials_pkey PRIMARY KEY (id),
  CONSTRAINT user_credentials_nonce_unique UNIQUE (key_version, iv),
  CONSTRAINT user_credentials_user_provider_unique UNIQUE (user_id, provider)
);
CREATE INDEX user_credentials_user_idx ON public.user_credentials USING btree (user_id, created_at DESC);

CREATE TABLE user_devices (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  fingerprint text NOT NULL,
  first_seen timestamp with time zone DEFAULT now() NOT NULL,
  last_seen timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT user_devices_pkey PRIMARY KEY (id),
  CONSTRAINT user_devices_unique UNIQUE (user_id, fingerprint)
);

CREATE TABLE user_sessions (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  refresh_token_hash text NOT NULL,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  revoked_at timestamp with time zone,
  access_token_hash text,
  ip_address text,
  user_agent text,
  CONSTRAINT user_sessions_pkey PRIMARY KEY (id),
  CONSTRAINT user_sessions_token_unique UNIQUE (refresh_token_hash)
);
CREATE INDEX user_sessions_user_idx ON public.user_sessions USING btree (user_id);

CREATE TABLE users (
  id bigint NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text DEFAULT 'user'::text NOT NULL,
  locale text DEFAULT 'fa'::text NOT NULL,
  email_verified_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL,
  full_name text DEFAULT ''::text NOT NULL,
  timezone text DEFAULT 'UTC'::text NOT NULL,
  plan text DEFAULT 'free'::text NOT NULL,
  status text DEFAULT 'active'::text NOT NULL,
  ai_consent_at timestamp with time zone,
  first_name text DEFAULT ''::text NOT NULL,
  last_name text DEFAULT ''::text NOT NULL,
  locale_source text DEFAULT 'default'::text NOT NULL,
  locale_updated_at timestamp with time zone,
  CONSTRAINT users_locale_check CHECK ((locale = ANY (ARRAY['fa'::text, 'en'::text]))),
  CONSTRAINT users_plan_check CHECK ((plan = ANY (ARRAY['free'::text, 'pro'::text, 'enterprise'::text]))),
  CONSTRAINT users_role_check CHECK ((role = ANY (ARRAY['user'::text, 'admin'::text, 'super_admin'::text]))),
  CONSTRAINT users_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text]))),
  CONSTRAINT users_pkey PRIMARY KEY (id),
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE TABLE voice_session_logs (
  id bigint NOT NULL,
  user_id bigint NOT NULL,
  session_uid text NOT NULL,
  started_at timestamp with time zone NOT NULL,
  ended_at timestamp with time zone,
  duration_seconds integer,
  alerts jsonb DEFAULT '[]'::jsonb NOT NULL,
  transcript_retained boolean DEFAULT false NOT NULL,
  transcript text,
  outcome text DEFAULT 'completed'::text NOT NULL,
  error_code text,
  created_at timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT voice_session_logs_alerts_check CHECK ((jsonb_typeof(alerts) = 'array'::text)),
  CONSTRAINT voice_session_logs_check CHECK (((transcript IS NULL) OR transcript_retained)),
  CONSTRAINT voice_session_logs_duration_seconds_check CHECK (((duration_seconds IS NULL) OR (duration_seconds >= 0))),
  CONSTRAINT voice_session_logs_error_code_check CHECK (((error_code IS NULL) OR (error_code ~ '^[A-Z0-9_]{1,48}$'::text))),
  CONSTRAINT voice_session_logs_outcome_check CHECK ((outcome = ANY (ARRAY['completed'::text, 'aborted'::text, 'error'::text]))),
  CONSTRAINT voice_session_logs_session_uid_check CHECK ((session_uid ~ '^[A-Za-z0-9_-]{8,64}$'::text)),
  CONSTRAINT voice_session_logs_time_sane CHECK (((ended_at IS NULL) OR (ended_at >= started_at))),
  CONSTRAINT voice_session_logs_pkey PRIMARY KEY (id),
  CONSTRAINT voice_session_logs_uid_unique UNIQUE (session_uid)
);
CREATE INDEX voice_session_logs_user_idx ON public.voice_session_logs USING btree (user_id, started_at DESC);

CREATE TABLE webhook_events (
  id bigint NOT NULL,
  source text NOT NULL,
  event_id text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamp with time zone DEFAULT now() NOT NULL,
  processed_at timestamp with time zone,
  signature_verified boolean DEFAULT false NOT NULL,
  signature_algorithm text,
  signature_verified_at timestamp with time zone,
  CONSTRAINT webhook_events_signature_evidence CHECK (((signature_verified = false) OR (signature_verified_at IS NOT NULL))),
  CONSTRAINT webhook_events_pkey PRIMARY KEY (id),
  CONSTRAINT webhook_events_dedupe UNIQUE (source, event_id)
);

-- ── foreign keys (emitted after all tables, so creation order cannot matter) ──

ALTER TABLE account_group_members ADD CONSTRAINT account_group_members_account_owner_fk FOREIGN KEY (account_id, user_id) REFERENCES trading_accounts(id, user_id) ON DELETE CASCADE;
ALTER TABLE account_group_members ADD CONSTRAINT account_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES account_groups(id) ON DELETE CASCADE;
ALTER TABLE account_group_members ADD CONSTRAINT account_group_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE account_groups ADD CONSTRAINT account_groups_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE account_performance_summary ADD CONSTRAINT account_performance_summary_account_id_fkey FOREIGN KEY (account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE;
ALTER TABLE account_performance_summary ADD CONSTRAINT account_performance_summary_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE ai_coaching_logs ADD CONSTRAINT ai_coaching_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE copy_relationships ADD CONSTRAINT copy_relationships_follower_owner_fk FOREIGN KEY (follower_account_id, follower_user_id) REFERENCES trading_accounts(id, user_id) ON DELETE RESTRICT;
ALTER TABLE copy_relationships ADD CONSTRAINT copy_relationships_follower_user_id_fkey FOREIGN KEY (follower_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE copy_relationships ADD CONSTRAINT copy_relationships_leader_owner_fk FOREIGN KEY (leader_account_id, leader_user_id) REFERENCES trading_accounts(id, user_id) ON DELETE RESTRICT;
ALTER TABLE copy_relationships ADD CONSTRAINT copy_relationships_leader_user_id_fkey FOREIGN KEY (leader_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE developer_api_keys ADD CONSTRAINT developer_api_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE device_tokens ADD CONSTRAINT device_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE email_preferences ADD CONSTRAINT email_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE email_verifications ADD CONSTRAINT email_verifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE installation_ownership ADD CONSTRAINT installation_ownership_claimed_by_user_id_fkey FOREIGN KEY (claimed_by_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE installation_ownership ADD CONSTRAINT installation_ownership_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE ml_model_predictions ADD CONSTRAINT ml_model_predictions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE password_resets ADD CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE prop_firm_rules ADD CONSTRAINT prop_firm_rules_account_owner_fk FOREIGN KEY (account_id, user_id) REFERENCES trading_accounts(id, user_id) ON DELETE CASCADE;
ALTER TABLE prop_firm_rules ADD CONSTRAINT prop_firm_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE provisioning_operations ADD CONSTRAINT provisioning_operations_account_id_fkey FOREIGN KEY (account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE;
ALTER TABLE provisioning_operations ADD CONSTRAINT provisioning_operations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE public_profiles ADD CONSTRAINT public_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE signal_queue ADD CONSTRAINT signal_queue_leader_account_id_fkey FOREIGN KEY (leader_account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE;
ALTER TABLE signal_queue ADD CONSTRAINT signal_queue_leader_user_id_fkey FOREIGN KEY (leader_user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE sync_fills ADD CONSTRAINT sync_fills_account_id_fkey FOREIGN KEY (account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE;
ALTER TABLE sync_fills ADD CONSTRAINT sync_fills_processed_trade_id_fkey FOREIGN KEY (processed_trade_id) REFERENCES trades(id) ON DELETE SET NULL;
ALTER TABLE sync_fills ADD CONSTRAINT sync_fills_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE sync_reservations ADD CONSTRAINT sync_reservations_account_id_fkey FOREIGN KEY (account_id) REFERENCES trading_accounts(id) ON DELETE CASCADE;
ALTER TABLE sync_reservations ADD CONSTRAINT sync_reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE tags ADD CONSTRAINT tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE tenants ADD CONSTRAINT tenants_owner_user_id_fkey FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE trade_attachments ADD CONSTRAINT trade_attachments_trade_owner_fk FOREIGN KEY (trade_id, user_id) REFERENCES trades(id, user_id) ON DELETE CASCADE;
ALTER TABLE trade_attachments ADD CONSTRAINT trade_attachments_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE trade_events ADD CONSTRAINT trade_events_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES trades(id);
ALTER TABLE trade_exits ADD CONSTRAINT trade_exits_trade_id_fkey FOREIGN KEY (trade_id) REFERENCES trades(id);
ALTER TABLE trade_tags ADD CONSTRAINT trade_tags_tag_owner_fk FOREIGN KEY (tag_id, user_id) REFERENCES tags(id, user_id) ON DELETE CASCADE;
ALTER TABLE trade_tags ADD CONSTRAINT trade_tags_trade_owner_fk FOREIGN KEY (trade_id, user_id) REFERENCES trades(id, user_id) ON DELETE CASCADE;
ALTER TABLE trade_tags ADD CONSTRAINT trade_tags_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE trades ADD CONSTRAINT trades_account_id_fkey FOREIGN KEY (account_id) REFERENCES trading_accounts(id);
ALTER TABLE trades ADD CONSTRAINT trades_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
ALTER TABLE trading_accounts ADD CONSTRAINT trading_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_analytics_daily ADD CONSTRAINT user_analytics_daily_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_credentials ADD CONSTRAINT user_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE user_devices ADD CONSTRAINT user_devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE user_sessions ADD CONSTRAINT user_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE voice_session_logs ADD CONSTRAINT voice_session_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.velora_apply_exit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE trade_volume NUMERIC(20,8); allocated NUMERIC(20,8);
BEGIN
  SELECT volume, allocated_volume INTO trade_volume, allocated FROM trades WHERE id = NEW.trade_id FOR UPDATE;
  IF allocated + NEW.volume > trade_volume THEN
    RAISE EXCEPTION 'over-allocation: % + % > %', allocated, NEW.volume, trade_volume;
  END IF;
  UPDATE trades SET allocated_volume = allocated + NEW.volume, updated_at = now() WHERE id = NEW.trade_id;
  RETURN NEW;
END; $function$;

CREATE TRIGGER trade_exits_guard BEFORE INSERT ON public.trade_exits FOR EACH ROW EXECUTE FUNCTION velora_apply_exit();

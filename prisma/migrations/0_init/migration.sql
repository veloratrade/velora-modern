-- Velora Modern — Phase 3 Baseline Migration (0_init)
-- Canonical Database Schema matching PHP Reference Repository (`veloratrade/veloratrade`)
-- Contains all 38 active canonical tables.

-- Create Table: users
CREATE TABLE `users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(255) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `full_name` VARCHAR(120) NOT NULL DEFAULT '',
    `role` ENUM('user', 'admin', 'super_admin') NOT NULL DEFAULT 'user',
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
    `locale` VARCHAR(35) NOT NULL DEFAULT 'fa',
    `locale_source` VARCHAR(16) NOT NULL DEFAULT 'default',
    `locale_updated_at` DATETIME(0) NULL,
    `ai_consent_at` DATETIME(0) NULL,
    `plan` ENUM('free', 'pro') NOT NULL DEFAULT 'free',
    `subscription_status` ENUM('none', 'active', 'past_due', 'grace', 'expired', 'cancelled') NOT NULL DEFAULT 'none',
    `plan_started_at` DATETIME(0) NULL,
    `plan_expires_at` DATETIME(0) NULL,
    `plan_updated_at` DATETIME(0) NULL,
    `status` ENUM('active', 'inactive', 'suspended') NOT NULL DEFAULT 'active',
    `email_verified_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `users_email_unique`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: user_sessions
CREATE TABLE `user_sessions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `refresh_token_hash` CHAR(64) NOT NULL,
    `access_token_hash` CHAR(64) NOT NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(250) NULL,
    `device_fingerprint` CHAR(64) NULL,
    `expires_at` DATETIME(0) NOT NULL,
    `revoked_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_user_sessions_refresh`(`refresh_token_hash`),
    INDEX `idx_user_sessions_user`(`user_id`),
    INDEX `idx_user_sessions_expires`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: auth_events
CREATE TABLE `auth_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NULL,
    `event_type` VARCHAR(32) NOT NULL DEFAULT 'login',
    `result` VARCHAR(16) NOT NULL,
    `reason` VARCHAR(64) NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(250) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_auth_events_user`(`user_id`),
    INDEX `idx_auth_events_ip`(`ip_address`),
    INDEX `idx_auth_events_type_created`(`event_type`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: password_resets
CREATE TABLE `password_resets` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(0) NOT NULL,
    `used_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `password_resets_token_hash_unique`(`token_hash`),
    INDEX `idx_password_resets_user`(`user_id`),
    INDEX `idx_password_resets_token`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: email_verifications
CREATE TABLE `email_verifications` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `token_hash` CHAR(64) NOT NULL,
    `expires_at` DATETIME(0) NOT NULL,
    `verified_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `email_verifications_token_hash_unique`(`token_hash`),
    INDEX `idx_email_verifications_user`(`user_id`),
    INDEX `idx_email_verifications_token`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: email_notifications
CREATE TABLE `email_notifications` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `event_type` VARCHAR(50) NOT NULL,
    `recipient_email` VARCHAR(255) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `status` ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
    `error_message` TEXT NULL,
    `sent_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_email_notif_user`(`user_id`),
    INDEX `idx_email_notif_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: email_preferences
CREATE TABLE `email_preferences` (
    `user_id` BIGINT UNSIGNED NOT NULL,
    `welcome_email` BOOLEAN NOT NULL DEFAULT true,
    `security_alerts` BOOLEAN NOT NULL DEFAULT true,
    `trade_notifications` BOOLEAN NOT NULL DEFAULT true,
    `weekly_report` BOOLEAN NOT NULL DEFAULT true,
    `marketing_emails` BOOLEAN NOT NULL DEFAULT false,
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    PRIMARY KEY (`user_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: user_achievements
CREATE TABLE `user_achievements` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `achievement_key` VARCHAR(80) NOT NULL,
    `achieved_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `metadata_json` LONGTEXT NULL,

    UNIQUE INDEX `uq_user_achievement`(`user_id`, `achievement_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: user_devices
CREATE TABLE `user_devices` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `fingerprint` CHAR(64) NOT NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(250) NULL,
    `device_name` VARCHAR(100) NULL,
    `is_trusted` BOOLEAN NOT NULL DEFAULT false,
    `last_active_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_user_device`(`user_id`, `fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: rate_limits
CREATE TABLE `rate_limits` (
    `bucket` VARCHAR(255) NOT NULL,
    `hits` INT UNSIGNED NOT NULL DEFAULT 1,
    `window_start` DATETIME(0) NOT NULL,

    INDEX `idx_rate_limits_window`(`window_start`),
    PRIMARY KEY (`bucket`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: trading_accounts
CREATE TABLE `trading_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `provider` ENUM('MT4', 'MT5', 'MANUAL') NOT NULL DEFAULT 'MANUAL',
    `platform` ENUM('MT4', 'MT5', 'MANUAL') NOT NULL DEFAULT 'MANUAL',
    `broker` VARCHAR(100) NULL,
    `server` VARCHAR(100) NULL,
    `timezone` VARCHAR(64) NULL,
    `timezone_source` VARCHAR(20) NOT NULL DEFAULT 'unknown',
    `mt_login` VARCHAR(50) NULL,
    `account_type` VARCHAR(20) NOT NULL DEFAULT 'STANDARD',
    `metaapi_account_id` VARCHAR(64) NULL,
    `sync_status` ENUM('DISCONNECTED', 'CONNECTING', 'SYNCING', 'CONNECTED', 'ERROR') NOT NULL DEFAULT 'DISCONNECTED',
    `last_synced_at` DATETIME(0) NULL,
    `connection_credentials_encrypted` VARBINARY(2048) NULL,
    `connected_at` DATETIME(0) NULL,
    `disconnected_at` DATETIME(0) NULL,
    `auto_sync_enabled` BOOLEAN NOT NULL DEFAULT true,
    `last_incremental_at` DATETIME(0) NULL,
    `connection_checked_at` DATETIME(0) NULL,
    `consecutive_errors` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `last_error` VARCHAR(500) NULL,
    `dev_force_error` BOOLEAN NOT NULL DEFAULT false,
    `starting_balance` DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    `current_balance` DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    `label` VARCHAR(100) NOT NULL DEFAULT 'Main Account',
    `account_number_masked` VARCHAR(30) NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'USD',
    `leverage` INT UNSIGNED NOT NULL DEFAULT 100,
    `status` ENUM('active', 'archived') NOT NULL DEFAULT 'active',
    `balance` DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    `equity` DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_accounts_metaapi`(`metaapi_account_id`),
    UNIQUE INDEX `uq_accounts_connection`(`user_id`, `platform`, `server`, `mt_login`),
    INDEX `idx_trading_accounts_user`(`user_id`),
    INDEX `idx_accounts_user_sync`(`user_id`, `sync_status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: trades
CREATE TABLE `trades` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `account_id` BIGINT UNSIGNED NULL,
    `external_deal_id` VARCHAR(64) NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `direction` ENUM('buy', 'sell') NOT NULL,
    `entry_price` DECIMAL(18, 8) NOT NULL,
    `exit_price` DECIMAL(18, 8) NULL,
    `volume` DECIMAL(18, 8) NOT NULL,
    `contract_size` DECIMAL(18, 8) NOT NULL DEFAULT 1.00000000,
    `commission` DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000,
    `swap` DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000,
    `profit_loss` DECIMAL(18, 8) NULL,
    `r_multiple` DECIMAL(10, 4) NULL,
    `stop_loss` DECIMAL(18, 8) NULL,
    `take_profit` DECIMAL(18, 8) NULL,
    `open_time` DATETIME(0) NOT NULL,
    `close_time` DATETIME(0) NULL,
    `occurred_open_at_utc` DATETIME(0) NULL,
    `occurred_close_at_utc` DATETIME(0) NULL,
    `time_status` VARCHAR(16) NOT NULL DEFAULT 'unresolved',
    `source_timezone` VARCHAR(64) NULL,
    `source_timezone_source` VARCHAR(20) NOT NULL DEFAULT 'unknown',
    `source_calendar` VARCHAR(16) NOT NULL DEFAULT 'unknown',
    `raw_open_text` VARCHAR(64) NULL,
    `raw_close_text` VARCHAR(64) NULL,
    `strategy_tag` VARCHAR(50) NULL,
    `emotional_score` TINYINT UNSIGNED NULL,
    `notes` TEXT NULL,
    `source` ENUM('manual', 'metaapi', 'import') NOT NULL DEFAULT 'manual',
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_trades_external_deal`(`account_id`, `external_deal_id`),
    INDEX `idx_trades_user`(`user_id`),
    INDEX `idx_trades_account`(`account_id`),
    INDEX `idx_trades_symbol`(`symbol`),
    INDEX `idx_trades_open_time`(`open_time`),
    INDEX `idx_user_account_time`(`user_id`, `account_id`, `close_time`),
    INDEX `idx_trades_occurred_open`(`user_id`, `occurred_open_at_utc`),
    INDEX `idx_trades_time_status`(`time_status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: trade_exits
CREATE TABLE `trade_exits` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `trade_id` BIGINT UNSIGNED NOT NULL,
    `exit_type` ENUM('tp', 'sl', 'manual', 'partial') NOT NULL DEFAULT 'manual',
    `exit_price` DECIMAL(18, 8) NOT NULL,
    `volume` DECIMAL(18, 8) NOT NULL,
    `pnl` DECIMAL(24, 8) NOT NULL DEFAULT 0.00000000,
    `exit_time` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_trade_exits_trade`(`trade_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: metaapi_operations
CREATE TABLE `metaapi_operations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `operation_key` CHAR(64) NOT NULL,
    `provider_marker` VARCHAR(64) NOT NULL,
    `request_fingerprint` CHAR(64) NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `account_id` BIGINT UNSIGNED NULL,
    `operation_type` VARCHAR(50) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
    `last_error` TEXT NULL,
    `payload` JSON NULL,
    `response_data` JSON NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_metaapi_operation_key`(`operation_key`),
    UNIQUE INDEX `uq_metaapi_provider_marker`(`provider_marker`),
    UNIQUE INDEX `uq_metaapi_request_fingerprint`(`request_fingerprint`),
    INDEX `idx_metaapi_operation_account`(`account_id`),
    INDEX `idx_metaapi_operation_user_status`(`user_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: sync_jobs
CREATE TABLE `sync_jobs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `type` ENUM('HISTORICAL', 'INCREMENTAL', 'WEBHOOK') NOT NULL DEFAULT 'HISTORICAL',
    `status` ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'DEAD_LETTER') NOT NULL DEFAULT 'PENDING',
    `payload` JSON NULL,
    `max_attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 5,
    `attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `last_error` TEXT NULL,
    `available_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `locked_at` DATETIME(0) NULL,
    `locked_by` VARCHAR(96) NULL,
    `lease_token` CHAR(64) NULL,
    `dedupe_key` VARCHAR(191) NULL,
    `range_from` DATETIME(0) NULL,
    `range_to` DATETIME(0) NULL,
    `started_at` DATETIME(0) NULL,
    `completed_at` DATETIME(0) NULL,
    `dead_lettered_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_sync_lease`(`lease_token`),
    UNIQUE INDEX `uq_sync_dedupe`(`dedupe_key`),
    INDEX `idx_sync_claim`(`status`, `available_at`, `id`),
    INDEX `idx_sync_stale`(`status`, `locked_at`),
    INDEX `idx_sync_account_created`(`account_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: webhook_events
CREATE TABLE `webhook_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `event_key` CHAR(64) NOT NULL,
    `account_id` BIGINT UNSIGNED NULL,
    `metaapi_account_id` VARCHAR(64) NULL,
    `event_type` VARCHAR(50) NOT NULL,
    `payload` JSON NOT NULL,
    `hmac_verified` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('PENDING', 'PROCESSED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `processing_token` CHAR(64) NULL,
    `processing_started_at` DATETIME(0) NULL,
    `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
    `last_error` VARCHAR(64) NULL,
    `processed_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_webhook_event_key`(`event_key`),
    UNIQUE INDEX `uq_webhook_processing_token`(`processing_token`),
    INDEX `idx_webhook_account`(`account_id`),
    INDEX `idx_webhook_type`(`event_type`),
    INDEX `idx_webhook_created`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: content_translation_cache
CREATE TABLE `content_translation_cache` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `content_type` VARCHAR(64) NOT NULL,
    `content_id` VARCHAR(191) NOT NULL,
    `source_locale` VARCHAR(35) NOT NULL,
    `target_locale` VARCHAR(35) NOT NULL,
    `field_name` VARCHAR(64) NOT NULL,
    `translated_text` LONGTEXT NOT NULL,
    `model_used` VARCHAR(64) NOT NULL DEFAULT 'system',
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_content_trans_cache`(`content_type`, `content_id`, `target_locale`, `field_name`),
    INDEX `idx_ctc_lookup`(`content_type`, `content_id`, `target_locale`),
    INDEX `idx_ctc_target`(`target_locale`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: content_translation_jobs
CREATE TABLE `content_translation_jobs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `content_type` VARCHAR(64) NOT NULL,
    `content_id` VARCHAR(191) NOT NULL,
    `source_locale` VARCHAR(35) NOT NULL,
    `target_locale` VARCHAR(35) NOT NULL,
    `status` ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
    `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
    `last_error` TEXT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    INDEX `idx_ctj_lookup`(`content_type`, `content_id`, `target_locale`),
    INDEX `idx_ctj_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_extractions
CREATE TABLE `ai_extractions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `provider` VARCHAR(32) NOT NULL DEFAULT 'gemini',
    `image_hash` CHAR(64) NOT NULL,
    `original_result` JSON NULL,
    `corrected_result` JSON NULL,
    `status` ENUM('pending', 'completed', 'corrected', 'failed') NOT NULL DEFAULT 'pending',
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    INDEX `idx_ai_ext_user`(`user_id`),
    INDEX `idx_ai_ext_hash`(`image_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_provider_quotas
CREATE TABLE `ai_provider_quotas` (
    `provider` VARCHAR(32) NOT NULL,
    `daily_used` INT UNSIGNED NOT NULL DEFAULT 0,
    `quota_limit` INT UNSIGNED NOT NULL DEFAULT 1500,
    `reset_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    PRIMARY KEY (`provider`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_provider_logs
CREATE TABLE `ai_provider_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `provider` VARCHAR(32) NOT NULL,
    `status` ENUM('success', 'failed', 'quota_exhausted', 'timeout') NOT NULL,
    `latency_ms` INT UNSIGNED NOT NULL DEFAULT 0,
    `error_code` VARCHAR(64) NULL,
    `feature` VARCHAR(64) NULL,
    `model` VARCHAR(64) NULL,
    `route` VARCHAR(16) NULL,
    `fallback_index` TINYINT UNSIGNED NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_ai_prov_logs_prov`(`provider`),
    INDEX `idx_ai_prov_logs_status`(`status`),
    INDEX `idx_ai_prov_logs_created`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_requests
CREATE TABLE `ai_requests` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `feature` VARCHAR(32) NOT NULL DEFAULT 'extraction',
    `provider` VARCHAR(32) NOT NULL DEFAULT 'gemini',
    `model` VARCHAR(64) NOT NULL DEFAULT 'gemini-1.5-flash',
    `status` ENUM('pending', 'completed', 'failed', 'quota_exceeded') NOT NULL DEFAULT 'pending',
    `latency_ms` INT UNSIGNED NOT NULL DEFAULT 0,
    `prompt_tokens` INT UNSIGNED NOT NULL DEFAULT 0,
    `completion_tokens` INT UNSIGNED NOT NULL DEFAULT 0,
    `estimated_cost_usd` DECIMAL(10, 6) NOT NULL DEFAULT 0.000000,
    `error_message` TEXT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_ai_req_user`(`user_id`),
    INDEX `idx_ai_req_feature`(`feature`),
    INDEX `idx_ai_req_provider`(`provider`),
    INDEX `idx_ai_req_created`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_feature_flags
CREATE TABLE `ai_feature_flags` (
    `feature_name` VARCHAR(64) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `rollout_percentage` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `updated_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    PRIMARY KEY (`feature_name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_audit_logs
CREATE TABLE `ai_audit_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `feature` VARCHAR(32) NOT NULL DEFAULT 'extraction',
    `provider` VARCHAR(32) NOT NULL DEFAULT 'gemini',
    `image_hash` CHAR(64) NOT NULL,
    `pii_detected` BOOLEAN NOT NULL DEFAULT false,
    `pii_redacted` BOOLEAN NOT NULL DEFAULT false,
    `action_taken` ENUM('logged', 'redacted', 'blocked') NOT NULL DEFAULT 'logged',
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_ai_audit_user`(`user_id`),
    INDEX `idx_ai_audit_feature`(`feature`),
    INDEX `idx_ai_audit_created`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_feedback
CREATE TABLE `ai_feedback` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `extraction_id` BIGINT UNSIGNED NULL,
    `original_result` JSON NULL,
    `corrected_result` JSON NULL,
    `feedback_type` ENUM('correction', 'rating', 'comment') NOT NULL DEFAULT 'correction',
    `rating` TINYINT UNSIGNED NULL,
    `comments` TEXT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_ai_fb_user`(`user_id`),
    INDEX `idx_ai_fb_ext`(`extraction_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_jobs
CREATE TABLE `ai_jobs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `job_type` VARCHAR(32) NOT NULL,
    `payload` JSON NOT NULL,
    `status` ENUM('pending', 'processing', 'completed', 'failed') NOT NULL DEFAULT 'pending',
    `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
    `last_error` TEXT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    INDEX `idx_ai_jobs_user`(`user_id`),
    INDEX `idx_ai_jobs_status`(`status`),
    INDEX `idx_ai_jobs_type`(`job_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_reports
CREATE TABLE `ai_reports` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `period_start` DATE NOT NULL,
    `period_end` DATE NOT NULL,
    `locale` VARCHAR(10) NOT NULL DEFAULT 'en',
    `content_md` LONGTEXT NOT NULL,
    `content_json` JSON NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_ai_reports_user`(`user_id`),
    INDEX `idx_ai_reports_period`(`user_id`, `period_start`, `period_end`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_analysis
CREATE TABLE `ai_analysis` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `provider` VARCHAR(32) NOT NULL DEFAULT 'gemini',
    `model` VARCHAR(64) NOT NULL DEFAULT 'gemini-1.5-flash',
    `result_json` JSON NOT NULL,
    `summary_md` TEXT NOT NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_ai_analysis_user`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_feature_providers
CREATE TABLE `ai_feature_providers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `feature` VARCHAR(64) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `model` VARCHAR(64) NULL,
    `priority` SMALLINT UNSIGNED NOT NULL DEFAULT 1,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `route` VARCHAR(16) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_afp_feature_provider`(`feature`, `provider`),
    INDEX `idx_afp_lookup`(`feature`, `enabled`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_global_settings
CREATE TABLE `ai_global_settings` (
    `setting_key` VARCHAR(64) NOT NULL,
    `setting_value` VARCHAR(64) NULL,
    `updated_by` BIGINT UNSIGNED NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    PRIMARY KEY (`setting_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: ai_provider_credentials
CREATE TABLE `ai_provider_credentials` (
    `provider` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL DEFAULT 'UNVERIFIED',
    `verified` BOOLEAN NOT NULL DEFAULT false,
    `fingerprint` VARCHAR(128) NULL,
    `auth_type` VARCHAR(32) NOT NULL DEFAULT 'NONE',
    `last_verified_at` DATETIME(0) NULL,
    `last_error_code` VARCHAR(64) NULL,
    `last_error_message` VARCHAR(500) NULL,
    `updated_by_user_id` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    PRIMARY KEY (`provider`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: admin_audit_logs
CREATE TABLE `admin_audit_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `actor_user_id` BIGINT UNSIGNED NOT NULL,
    `actor_role` VARCHAR(32) NOT NULL DEFAULT 'admin',
    `action` VARCHAR(64) NOT NULL,
    `target_type` VARCHAR(32) NOT NULL DEFAULT 'user',
    `target_id` VARCHAR(128) NULL,
    `reason` VARCHAR(255) NULL,
    `ip_address` VARCHAR(45) NULL,
    `payload_before` JSON NULL,
    `payload_after` JSON NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_admin_audit_actor`(`actor_user_id`),
    INDEX `idx_admin_audit_action`(`action`),
    INDEX `idx_admin_audit_target`(`target_type`, `target_id`),
    INDEX `idx_admin_audit_created`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: system_logs
CREATE TABLE `system_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `severity` VARCHAR(8) NOT NULL DEFAULT 'INFO',
    `source` VARCHAR(64) NOT NULL,
    `message` VARCHAR(1000) NULL,
    `request_id` VARCHAR(64) NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `context_json` JSON NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_system_logs_severity`(`severity`),
    INDEX `idx_system_logs_source`(`source`),
    INDEX `idx_system_logs_user`(`user_id`),
    INDEX `idx_system_logs_req`(`request_id`),
    INDEX `idx_system_logs_created`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: integration_health
CREATE TABLE `integration_health` (
    `integration` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `latency_ms` INT UNSIGNED NULL,
    `error_code` VARCHAR(64) NULL,
    `message` VARCHAR(500) NULL,
    `last_checked_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    PRIMARY KEY (`integration`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: metaapi_fills
CREATE TABLE `metaapi_fills` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `external_deal_id` VARCHAR(64) NOT NULL,
    `position_id` VARCHAR(64) NULL,
    `symbol` VARCHAR(32) NOT NULL,
    `type` ENUM('buy', 'sell') NOT NULL,
    `entry_type` ENUM('in', 'out', 'inout') NOT NULL DEFAULT 'in',
    `volume` DECIMAL(18, 8) NOT NULL,
    `price` DECIMAL(18, 8) NOT NULL,
    `profit` DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000,
    `commission` DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000,
    `swap` DECIMAL(18, 8) NOT NULL DEFAULT 0.00000000,
    `fill_time` DATETIME(0) NOT NULL,
    `platform` ENUM('MT4', 'MT5') NOT NULL DEFAULT 'MT5',
    `raw_payload` JSON NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_metaapi_fills_account_deal`(`account_id`, `external_deal_id`),
    INDEX `idx_metaapi_fills_user`(`user_id`),
    INDEX `idx_metaapi_fills_time`(`fill_time`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: support_conversations
CREATE TABLE `support_conversations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `subject` VARCHAR(200) NOT NULL,
    `status` ENUM('open', 'pending', 'closed', 'archived') NOT NULL DEFAULT 'open',
    `waiting_for` ENUM('admin', 'user', 'none') NOT NULL DEFAULT 'admin',
    `priority` ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal',
    `last_message_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `unread_admin_count` INT UNSIGNED NOT NULL DEFAULT 0,
    `unread_user_count` INT UNSIGNED NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),

    INDEX `idx_sc_user`(`user_id`),
    INDEX `idx_sc_status`(`status`),
    INDEX `idx_sc_waiting`(`waiting_for`),
    INDEX `idx_sc_last_msg`(`last_message_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: support_messages
CREATE TABLE `support_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `conversation_id` BIGINT UNSIGNED NOT NULL,
    `sender_type` ENUM('user', 'admin', 'system') NOT NULL,
    `sender_user_id` BIGINT UNSIGNED NULL,
    `body` TEXT NOT NULL,
    `body_source_language` VARCHAR(8) NOT NULL DEFAULT 'fa',
    `read_at` DATETIME(0) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_sm_conv`(`conversation_id`),
    INDEX `idx_sm_sender`(`sender_user_id`),
    INDEX `idx_sm_created`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create Table: support_message_translations
CREATE TABLE `support_message_translations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `message_id` BIGINT UNSIGNED NOT NULL,
    `source_language` VARCHAR(8) NOT NULL,
    `target_language` VARCHAR(8) NOT NULL,
    `translated_body` TEXT NOT NULL,
    `translated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uq_smt_msg_lang`(`message_id`, `target_language`),
    INDEX `idx_smt_msg`(`message_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Add Foreign Keys
ALTER TABLE `user_sessions` ADD CONSTRAINT `user_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `auth_events` ADD CONSTRAINT `auth_events_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `password_resets` ADD CONSTRAINT `password_resets_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `email_verifications` ADD CONSTRAINT `email_verifications_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `email_notifications` ADD CONSTRAINT `email_notifications_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `email_preferences` ADD CONSTRAINT `email_preferences_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_achievements` ADD CONSTRAINT `user_achievements_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `user_devices` ADD CONSTRAINT `user_devices_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `trading_accounts` ADD CONSTRAINT `trading_accounts_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `trades` ADD CONSTRAINT `trades_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `trades` ADD CONSTRAINT `trades_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `trading_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `trade_exits` ADD CONSTRAINT `trade_exits_trade_id_fkey` FOREIGN KEY (`trade_id`) REFERENCES `trades`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `metaapi_operations` ADD CONSTRAINT `metaapi_operations_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `metaapi_operations` ADD CONSTRAINT `metaapi_operations_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `trading_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `sync_jobs` ADD CONSTRAINT `sync_jobs_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `trading_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `sync_jobs` ADD CONSTRAINT `sync_jobs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `webhook_events` ADD CONSTRAINT `webhook_events_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `trading_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ai_extractions` ADD CONSTRAINT `ai_extractions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ai_requests` ADD CONSTRAINT `ai_requests_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ai_audit_logs` ADD CONSTRAINT `ai_audit_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ai_feedback` ADD CONSTRAINT `ai_feedback_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ai_feedback` ADD CONSTRAINT `ai_feedback_extraction_id_fkey` FOREIGN KEY (`extraction_id`) REFERENCES `ai_extractions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `ai_jobs` ADD CONSTRAINT `ai_jobs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ai_reports` ADD CONSTRAINT `ai_reports_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `ai_analysis` ADD CONSTRAINT `ai_analysis_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `admin_audit_logs` ADD CONSTRAINT `admin_audit_logs_actor_user_id_fkey` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE `system_logs` ADD CONSTRAINT `system_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `metaapi_fills` ADD CONSTRAINT `metaapi_fills_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `trading_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `metaapi_fills` ADD CONSTRAINT `metaapi_fills_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `support_conversations` ADD CONSTRAINT `support_conversations_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `support_messages` ADD CONSTRAINT `support_messages_conversation_id_fkey` FOREIGN KEY (`conversation_id`) REFERENCES `support_conversations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `support_messages` ADD CONSTRAINT `support_messages_sender_user_id_fkey` FOREIGN KEY (`sender_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `support_message_translations` ADD CONSTRAINT `support_message_translations_message_id_fkey` FOREIGN KEY (`message_id`) REFERENCES `support_messages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

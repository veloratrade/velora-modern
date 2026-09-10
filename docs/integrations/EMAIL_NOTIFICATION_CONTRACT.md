# Velora Modern — Email & Transactional Notification Contract

## Purpose

This document specifies the transactional email delivery pipeline, Resend API integration, email templates, failure handling, and user notification preferences for **Velora Modern** (`veloratrade/velora-modern`). It reconciles legacy PHP implementations (`Mailer.php`, `NotificationService.php`).

---

## 1. Provider & Architecture

- **Primary Provider**: **Resend** transactional email API (`resend` NPM SDK / HTTP API).
- **Configuration**:
  - `MAIL_DRIVER`: Set to `resend`.
  - `RESEND_API_KEY`: API key for Resend authentication.
  - `EMAIL_FROM`: Default sender address (`VELORA TRADE <no-reply@veloratrade.ir>`).
  - `EMAIL_REPLY_TO`: Optional reply-to address (`support@veloratrade.ir`).

---

## 2. Notification Event Catalog

| Event ID | Template Name | Trigger Event | Priority | Async / Sync |
| :--- | :--- | :--- | :--- | :--- |
| `AUTH_WELCOME` | `welcome-email` | New user registration | High | Async Queue |
| `AUTH_PASSWORD_RESET` | `password-reset` | Password reset request | Critical | Immediate Sync |
| `AUTH_LOGIN_ALERT` | `new-device-login` | Login from unrecognized IP/device | High | Async Queue |
| `TRADE_ALERT` | `trade-risk-alert` | Daily drawdown or risk breach | Medium | Async Queue |
| `AI_WEEKLY_REPORT` | `weekly-journal-digest` | Sunday weekly AI digest generated | Low | Scheduled Batch |
| `BILLING_INVOICE` | `subscription-receipt` | Payment processed / subscription renewed | High | Async Queue |

---

## 3. Bilingual Template Rendering & Encoding

- All email templates support English (`en`) and Persian (`fa`) localized content.
- Persian emails (`fa`) MUST use right-to-left (`dir="rtl"`) HTML layouts and Persian typography, but ALL numbers, prices, dates, and trade metrics MUST render with ASCII/Latin digits (`0-9`).
- Brand names `"VELORA"` and `"MetaAPI"` MUST remain unmodified.

---

## 4. User Notification Preferences & Unsubscribe

- Users can customize notification preferences in account settings (`emailNotificationsEnabled`, `weeklyDigestEnabled`, `securityAlertsEnabled`).
- Critical security events (password resets, account suspension notices) override marketing/digest preferences and are always delivered.
- Transactional emails MUST include an unsubscribe header (`List-Unsubscribe`) and direct management link.

---

## 5. Failure Handling & Delivery Logging

- Email dispatch calls MUST be wrapped in try/catch blocks to ensure email provider outages never break core API workflows.
- Email delivery status, recipient, template name, and provider message ID (`lastMessageId`) MUST be logged to application logs and `email_notifications` database table.

---

## Provenance & Traceability Matrix

| Requirement | PHP Evidence File | Classification | Modern Target Document | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Resend API Integration** | `api/src/Core/Mailer.php` (`MAIL_DRIVER=resend`) | `SHARED_ADAPTED` | `docs/integrations/EMAIL_NOTIFICATION_CONTRACT.md` | `TRANSFER_COMPLETED` |
| **Notification Service & Logging** | `api/src/Core/NotificationService.php` | `SHARED_ADAPTED` | `docs/integrations/EMAIL_NOTIFICATION_CONTRACT.md` | `TRANSFER_COMPLETED` |
| **Email Log Schema** | `api/src/Core/EmailNotificationRepository.php` | `SHARED_REQUIRED` | `prisma/schema.prisma` | `VERIFIED` |

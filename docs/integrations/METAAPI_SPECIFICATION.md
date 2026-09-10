# Velora Modern — MetaAPI Integration Specification

## Purpose

This document specifies the integration contract, database schema alignment, webhook ingestion pipeline, and synchronization rules for connecting MetaTrader 4 (MT4) and MetaTrader 5 (MT5) cloud accounts via **MetaAPI** in **Velora Modern** (`veloratrade/velora-modern`). It reconciles legacy PHP implementation files (`MetaApiService.php`, `MetaApiWebhookController.php`, `v0.2_metaapi_bridge.sql`).

---

## 1. Architectural Overview

MetaAPI acts as the cloud bridge between Velora Modern and MetaTrader broker terminals.

```
[ MT4 / MT5 Broker ] <───> [ MetaAPI Cloud Service ]
                                   │
                                   │ (HTTP / Webhooks / WebSocket)
                                   ▼
                        [ Velora Modern Backend ]
                                   │
                                   ├── MetaApiService (REST API Management)
                                   ├── MetaApiWebhookController (Deal Ingestion)
                                   └── FillLedgerService (Trade Matching)
```

---

## 2. Commercial Entitlements & Account Quotas

- **Free Plan**: Maximum 1 Trading Account across MT4, MT5, or MANUAL accounts.
- **Pro / Subscribed Plan**: Unlimited Trading Accounts.
- **Quota Verification**: The system MUST check the user's active plan and account count in `trading_accounts` before issuing a MetaAPI account provisioning call. If limit is exceeded, return HTTP 403 `ACCOUNT_LIMIT_REACHED`.
- **Projects Exclusion**: Projects are explicitly EXCLUDED from account quota restrictions.

---

## 3. Account Provisioning Lifecycle

1. **User Request**: User submits broker login credentials, server name, platform type (`MT4` or `MT5`), and optional password.
2. **Server Auto-Detect**: Call MetaAPI Server Auto-Detect API to verify broker server name validity.
3. **Provision Account**: Post account creation payload to MetaAPI Cloud API (`/provisioning/v1/accounts`).
4. **Store Record**: Save record in `trading_accounts` table:
   - `platform`: `MT4` | `MT5`
   - `accountNumber`: Broker account ID string
   - `metaapiAccountId`: Returned MetaAPI UUID
   - `syncStatus`: Set to `'CONNECTING'`
5. **Deploy & Connect**: Call MetaAPI deploy endpoint (`/provisioning/v1/accounts/{id}/deploy`). Upon connection success, update `syncStatus` to `'CONNECTED'`.
6. **Historical Sync**: Queue historical deal sync job to retrieve historical closed trades.

---

## 4. Webhook Ingestion & Fill Ledger Matching

MetaAPI streams real-time trade execution events via HTTPS POST webhooks to `/api/v1/webhooks/metaapi`.

### Webhook Security & Signature Verification
- Incoming requests MUST contain valid HMAC SHA-256 signature header matching `METAAPI_WEBHOOK_SECRET`.
- Unsigned or invalid requests MUST return HTTP 401 `UNAUTHORIZED`.

### Event Types
- `deal`: Trade execution (position entry, exit, or partial fill).
- `account_status`: Account connection state change (`CONNECTED`, `DISCONNECTED`, `ERROR`).

### Idempotency & Processing Rules
- Each webhook event carries a unique `dealId`.
- The webhook controller MUST check if `dealId` exists in `trades` or transaction ledger.
- Duplicate deals MUST be safely ignored (return HTTP 200 `{ status: "success", data: { duplicate: true } }`).
- Valid deals MUST be stored with scale 8 Decimal precision for price, volume, commission, swap, and profit.
- Recalculate metrics for affected `trading_accounts` upon deal processing.

---

## 5. Account Disconnect & Cleanup Protocol

When a user removes or disconnects a MetaAPI account:
1. Issue undeploy call to MetaAPI (`/provisioning/v1/accounts/{id}/undeploy`).
2. Delete account from MetaAPI cloud (`DELETE /provisioning/v1/accounts/{id}`).
3. Update local `trading_accounts` status to `'DISCONNECTED'`.
4. Retain historical trade records in `trades` table with preserved foreign keys unless user explicitly requests complete purge.

---

## Provenance & Traceability Matrix

| Requirement | PHP Evidence File | Classification | Modern Target Document | Status |
| :--- | :--- | :--- | :--- | :--- |
| **MetaAPI Service & Provisioning** | `api/src/Services/MetaApiService.php` | `SHARED_ADAPTED` | `docs/integrations/METAAPI_SPECIFICATION.md` | `TRANSFER_COMPLETED` |
| **Webhook Deal Ingestion & HMAC** | `api/src/Webhooks/MetaApiWebhookController.php` | `SECURITY_REQUIREMENT` | `docs/integrations/METAAPI_SPECIFICATION.md` | `TRANSFER_COMPLETED` |
| **Database Schema Bridge** | `database/migrations/v0.2_metaapi_bridge.sql` | `SHARED_REQUIRED` | `prisma/schema.prisma` | `VERIFIED` |
| **Account Entitlements Quota** | `business-rules.md` (Confirmed Rule) | `OPERATIONAL_REQUIREMENT` | `docs/integrations/METAAPI_SPECIFICATION.md` | `TRANSFER_COMPLETED` |

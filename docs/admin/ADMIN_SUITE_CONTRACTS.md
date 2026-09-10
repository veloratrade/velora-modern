# Velora Modern — Admin Suite API Contracts & Specification

## Purpose

This document specifies the REST API contracts, authorization requirements, and administrative capabilities for the **Admin Suite** in **Velora Modern** (`veloratrade/velora-modern`). It reconciles the requirements from the 25 legacy PHP Admin controllers and services (`api/src/Admin/*`).

---

## Administrative Roles & Authorization

- All Admin Suite endpoints are prefixed under `/api/v1/admin/`.
- Access requires a valid Bearer JWT belonging to a user with `role === 'admin'` or `role === 'super_admin'`.
- Access attempts by standard `user` accounts MUST be rejected with HTTP 403 `FORBIDDEN`.
- Every administrative action MUST produce an immutable entry in the `audit_logs` table recording `adminId`, `action`, `targetType`, `targetId`, `ipAddress`, and `payload`.

---

## Admin Suite Module Domains

### 1. User 360 & Account Management (`/api/v1/admin/users`)

#### Endpoints
- `GET /api/v1/admin/users`: Paginated user list with filters (search, role, plan, status).
- `GET /api/v1/admin/users/:userId`: Detailed User 360 profile (profile, attached trading accounts, subscription plan, active sessions, risk overview).
- `PATCH /api/v1/admin/users/:userId/role`: Update user role (`user`, `admin`, `super_admin`).
- `PATCH /api/v1/admin/users/:userId/plan`: Update subscription plan (`free`, `pro`, `enterprise`).
- `POST /api/v1/admin/users/:userId/suspend`: Suspend user account (invalidates all active refresh tokens).
- `POST /api/v1/admin/users/:userId/reactivate`: Reactivate suspended user account.

### 2. System Diagnostics & Infrastructure Health (`/api/v1/admin/system`)

#### Endpoints
- `GET /api/v1/admin/system/health`: System health status (database connectivity, latency, memory usage, uptime).
- `GET /api/v1/admin/system/probes`: Active connectivity status for upstream integrations (MetaAPI, Resend Email, AI Providers, Prisma DB).
- `GET /api/v1/admin/system/metrics`: Application throughput, active web sockets, queue depth, error rates.

### 3. AI Provider Routing & Vault Management (`/api/v1/admin/ai`)

#### Endpoints
- `GET /api/v1/admin/ai/providers`: List configured AI providers (OpenAI, Gemini), credentials status, priority weights.
- `PUT /api/v1/admin/ai/providers/:providerId`: Update provider API key, default model, usage quota limit, or active status.
- `GET /api/v1/admin/ai/usage`: Aggregated AI token usage metrics, costs, and breakdown by model/user.

### 4. Dynamic Feature Flags Governance (`/api/v1/admin/features`)

#### Endpoints
- `GET /api/v1/admin/features`: List all system feature flags (`feature_flags` table).
- `POST /api/v1/admin/features`: Create a new feature flag key.
- `PATCH /api/v1/admin/features/:key`: Toggle feature flag state (`enabled: boolean`), rollout percentage, or targeted user segments.

### 5. MetaAPI Cloud Connectivity & Bridge Admin (`/api/v1/admin/metaapi`)

#### Endpoints
- `GET /api/v1/admin/metaapi/accounts`: List all MetaAPI connected trading accounts, sync state, and latency metrics.
- `POST /api/v1/admin/metaapi/accounts/:accountId/resync`: Trigger manual historical trade re-synchronization.
- `DELETE /api/v1/admin/metaapi/accounts/:accountId`: Force disconnect MetaAPI cloud account and purge webhook subscriptions.

### 6. Billing & Subscription Management (`/api/v1/admin/billing`)

#### Endpoints
- `GET /api/v1/admin/billing/subscriptions`: List active subscriptions, renewal dates, MRR metrics.
- `POST /api/v1/admin/billing/grant`: Manual subscription grant or extension for a user.

### 7. Security Audit Log Viewer (`/api/v1/admin/audit-logs`)

#### Endpoints
- `GET /api/v1/admin/audit-logs`: Searchable, paginated audit log feed (`audit_logs` table) with filtering by admin ID, action type, date range, or IP address.

---

## Provenance & Traceability Matrix

| Admin Domain | PHP Evidence Source | Classification | Modern Target Document | Status |
| :--- | :--- | :--- | :--- | :--- |
| **User 360 & Roles** | `api/src/Admin/Controllers/UserController.php` | `SHARED_ADAPTED` | `docs/admin/ADMIN_SUITE_CONTRACTS.md` | `TRANSFER_COMPLETED` |
| **System Health & Probes** | `api/src/Admin/Controllers/DiagnosticsController.php` | `SHARED_ADAPTED` | `docs/admin/ADMIN_SUITE_CONTRACTS.md` | `TRANSFER_COMPLETED` |
| **AI Vault & Providers** | `api/src/Admin/Controllers/AIConfigController.php` | `SHARED_ADAPTED` | `docs/admin/ADMIN_SUITE_CONTRACTS.md` | `TRANSFER_COMPLETED` |
| **Dynamic Feature Flags** | `api/src/Services/FeatureFlagService.php` | `SHARED_ADAPTED` | `docs/admin/ADMIN_SUITE_CONTRACTS.md` | `TRANSFER_COMPLETED` |
| **MetaAPI Admin** | `api/src/Admin/Controllers/MetaApiAdminController.php` | `SHARED_ADAPTED` | `docs/admin/ADMIN_SUITE_CONTRACTS.md` | `TRANSFER_COMPLETED` |
| **Security Audit Logs** | `api/src/Admin/Services/AuditLogService.php` | `SECURITY_REQUIREMENT` | `docs/admin/ADMIN_SUITE_CONTRACTS.md` | `TRANSFER_COMPLETED` |

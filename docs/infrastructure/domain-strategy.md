# Velora Modern Domain & DNS Strategy

* **Status**: APPROVED DESIGN / NOT YET PROVISIONED
* **Date**: 2026-09-10 (UTC)

---

## 1. Executive Summary

This document defines the domain and DNS routing strategy for the migration from the legacy PHP/MySQL implementation (`veloratrade/veloratrade`) to the modern Node.js/TypeScript architecture (`veloratrade/velora-modern`).

---

## 2. Current State

| Domain / Hostname | Target Platform | Implementation | Status |
| :--- | :--- | :--- | :--- |
| **`veloratrade.ir`** | Existing Hosting / Server | Current PHP Production | **ACTIVE / UNCHANGED** |

* **DNS Status**: **UNCHANGED**. DNS A/CNAME records remain pointed to the live PHP application.
* **Railway Ownership**: Railway does **NOT** own or route the primary domain `veloratrade.ir`.
* **Production Status**: Current live traffic and users continue using the PHP application with zero disruption.

---

## 3. Future Planned State (Modern Architecture)

The following naming strategy is approved for pre-migration deployment and testing:

```text
Current Live Traffic:
  veloratrade.ir                 ──────> Current PHP Production (Unchanged)

Future Modern Staging:
  staging-modern.veloratrade.ir  ──────> Railway Staging (velora-modern)

Future Modern Production:
  modern.veloratrade.ir          ──────> Railway Production (velora-modern)
```

| Hostname | Target Railway Environment | Purpose | Provisioning Status |
| :--- | :--- | :--- | :--- |
| **`staging-modern.veloratrade.ir`** | `staging` | Staging testing & validation | **PLANNED / NOT YET PROVISIONED** |
| **`modern.veloratrade.ir`** | `production` | Pre-cutover production testing | **PLANNED / NOT YET PROVISIONED** |

---

## 4. Key Architectural & DNS Safety Rules

1. **Primary Domain Safeguard**: `veloratrade.ir` remains exclusively assigned to the PHP production application until the modern rewrite achieves 100% functional parity and security approval.
2. **Staging Hostname Isolation**: Modern Staging must use a separate hostname (`staging-modern.veloratrade.ir`) and must never conflict with or replace the PHP production hostname.
3. **Parallel Production Testing**: Modern Production will initially run on a dedicated hostname (`modern.veloratrade.ir`) allowing end-to-end verification under real production environment conditions without affecting live users.
4. **Deliberate Cutover**: Migration of the primary domain `veloratrade.ir` to Railway will occur only after full feature parity, security audit, integration testing, and explicit stakeholder approval.
5. **Independent DNS Management**: DNS record updates must be executed as separate, deliberate operations. No automatic DNS changes occur as a side-effect of code commits or Railway deployments.
6. **Documentation Scope**: The existence of this documentation does NOT trigger or imply active Railway domain configuration or DNS record creation.

---

## 5. Final Cutover Vision (Out of Scope for Current Task)

Only after explicit production-readiness approval:

```text
Current (Active):
  veloratrade.ir ──────> Current PHP Production

Future (Post-Cutover Approval):
  veloratrade.ir ──────> Modern Production (Railway)
```

This final cutover is **OUT OF SCOPE** for the current setup phase.

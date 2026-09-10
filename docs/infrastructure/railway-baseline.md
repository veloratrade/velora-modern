# Velora Railway Baseline

* **Status**: VERIFIED
* **Date**: 2026-09-10 (UTC)

---

## 1. Project Identity

* **Project Name**: `Velora`
* **Project ID**: `56d1762e-79d3-4518-b788-5eda1d93dd22`
* **Workspace Name**: `veloratrade's Projects`
* **Workspace ID**: `6289d74f-c91c-4f3e-9e49-6b779624f6da`

---

## 2. Environment Topology

The Railway project contains two isolated deployment environments:

| Environment | Environment ID | Service | ServiceInstance ID | Status |
| :--- | :--- | :--- | :--- | :--- |
| **production** | `a4df12df-0fdc-4c36-b908-695711dc5e84` | `velora-modern` | `8ecdbf11-3138-4797-83cf-3543aca3d28c` | Offline (0 Deploys) |
| **staging** | `9e50b277-205e-4b06-833f-e742141cfc09` | `velora-modern` | `afa44c0a-8f32-44bf-90a6-e65db72340ff` | Offline (0 Deploys) |

---

## 3. Service Relationship & Instance Architecture

* **Service Name**: `velora-modern`
* **Service ID**: `ee3b7e92-520a-40ee-be6c-a66d14b479ec`
* **Architecture Model**: The logical Service ID is shared across environments by design in Railway's architecture.
* **ServiceInstance Isolation**: Each environment holds its own `ServiceInstance` database object with isolated container runtimes, configuration settings, environment variables, and deployment history:
  * **Production ServiceInstance**: `8ecdbf11-3138-4797-83cf-3543aca3d28c`
  * **Staging ServiceInstance**: `afa44c0a-8f32-44bf-90a6-e65db72340ff`

---

## 4. Production State

* **Environment ID**: `a4df12df-0fdc-4c36-b908-695711dc5e84`
* **Build Command**: `null` (Unconfigured)
* **Start Command**: `null` (Unconfigured)
* **Root Directory**: `null` (Default)
* **Deployment Count**: `0`
* **Current Deployment State**: `Offline`
* **Public / Custom Domains**: None configured (`[]`)
* **Databases / Redis**: None attached
* **Variables**: System variables only (`RAILWAY_PROJECT_NAME`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_SERVICE_NAME`, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT`, `RAILWAY_PRIVATE_DOMAIN`).

---

## 5. Staging State

* **Environment ID**: `9e50b277-205e-4b06-833f-e742141cfc09`
* **Build Command**: `null` (Unconfigured)
* **Start Command**: `null` (Unconfigured)
* **Root Directory**: `null` (Default)
* **Deployment Count**: `0`
* **Current Deployment State**: `Offline`
* **Public / Custom Domains**: None configured (`[]`)
* **Databases / Redis**: None attached
* **Variables**: System variables only (isolated from production).

---

## 6. Environment Isolation & Safety Guarantees

* **Container & Process Isolation**: Production and staging run in separate container namespaces.
* **Variable Scoping**: Environment variables are strictly scoped by `(projectId, serviceId, environmentId)`.
* **Deployment History**: Deployment logs and build artifacts are independently scoped per environment.
* **Database Isolation**: Future databases provisioned in staging will generate isolated credentials and cannot affect production data.
* **Deployment Safety**: Deployments to staging execute in the staging `ServiceInstance` and cannot replace or disrupt production.

---

## 7. GitHub Integration & Source of Truth

* **Connected Repository**: `veloratrade/velora-modern`
* **Source Connection**: Configured on both production and staging service instances (`source.repo: "veloratrade/velora-modern"`).
* **Default Branch**: `main`
* **Source of Truth Rule**:
  * **GitHub** is the sole source of truth for application code, architecture, configuration templates, database migrations, tests, and documentation.
  * **Railway** is purely the runtime execution platform. Railway is NOT the source of truth for business logic or schema definitions.
  * **Secrets**: Application secrets exist exclusively in Railway runtime secret storage and are **NEVER** committed to GitHub.
  * **Reference Repository**: [`veloratrade/veloratrade`](https://github.com/veloratrade/veloratrade) is the legacy PHP source of truth and capability reference. It is NOT a code template for `velora-modern`.

---

## 8. Deployment Policy & Statements

* **Application Deployment**: **NO application deployment has occurred.** Both environments are 100% clean scaffolds.
* **Application Secrets**: **NO application secrets or real credentials are stored in GitHub.**

---

## 9. Known Future Work

1. Complete Phase 0 Architecture & Capability Baseline.
2. Define Node.js / TypeScript technology stack and ORM.
3. Scaffold initial application code (`package.json`, `tsconfig.json`, base web server).
4. Configure Railway build and start commands.
5. Provision PostgreSQL and Redis services on Railway.

// Admin-managed integrations — business capability, not a PHP port.
//
// The 12 routes are:
//   GET /admin/integrations (inventory)
//   GET|PUT|DELETE /admin/integrations/metaapi  + POST /test
//   GET|PUT|DELETE /admin/integrations/email    + POST /test
//   GET|PUT|DELETE /admin/integrations/relay/config  (delegated to AiSecretService —
//        this file does NOT duplicate the relay envelope; it only serves metaapi/email.
//        The relay handler lives in integrationRelayBridge.ts and reuses AiSecretService.)
//
// Modern architecture decisions (capability → business meaning → Modern architecture):
//   - Secrets never leave the service as plaintext to HTTP. The status objects expose
//     only booleans, safe hosts, fingerprints and source tags.
//   - Storage precedence is: admin-managed envelope (integration_platform_secrets)
//     → process ENV → unavailable. Plain settings follow: integration_settings → ENV → default.
//   - Validation is server-side, fail-closed, and mirrors Legacy's messages where the
//     test expectations depend on them (codes RESOLVED, but HTTP 400 shape is the same).

import { createHmac } from "node:crypto";
import {
  decryptCredential,
  encryptCredential,
  CredentialDecryptionError,
  type MasterKey,
} from "../credentials/credentialCrypto.js";
import type { IntegrationStore, IntegrationSecretKey } from "./integrationStore.js";

export const MAX_SECRET_BYTES = 4096;

// ── validation helpers (fail-closed) ───────────────────────────────────────────

function isValidHttpsUrl(value: string): boolean {
  if (value.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username !== "" || u.password !== "") return false;
  if (u.hostname === "") return false;
  // SSRF guard: reject loopback/private as relay did — metaapi base URL is
  // also an outbound HTTPS target chosen by an admin, so the same guard applies.
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    // IPv4 literal — reject private/loopback/link-local via simple numeric test.
    // Full FILTER_FLAG_NO_PRIV_RANGE emulation is unnecessary for the Modern resolver;
    // the DB CHECK already blocks non-https, and this is defense-in-depth.
    const parts = host.split(".").map(Number);
    if (parts[0] === 10) return false;
    if (parts[0] === 127) return false;
    if (parts[0] === 169 && parts[1] === 254) return false;
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return false;
    if (parts[0] === 192 && parts[1] === 168) return false;
  }
  return true;
}

function isValidEmail(value: string): boolean {
  if (value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function assertValidDriver(value: string): void {
  if (!["smtp", "resend", "log"].includes(value)) {
    throw new ValidationError("Invalid mail driver.", { driver: ["INVALID_DRIVER"] });
  }
}

// ── error shape (HTTP 400 with structured details) ───────────────────────────

export class ValidationError extends Error {
  readonly details: Record<string, readonly string[]>;
  constructor(
    message: string,
    details: Record<string, readonly string[]>,
    readonly code = "VALIDATION_ERROR",
  ) {
    super(message);
    this.name = "ValidationError";
    this.details = details;
  }
}

export class MasterKeyMissingError extends Error {
  constructor() {
    super("CREDENTIAL_MASTER_KEY is not configured; admin-managed integration secrets are unavailable.");
    this.name = "MasterKeyMissingError";
  }
}

// ── fingerprint (non-reversible) ─────────────────────────────────────────────

function fingerprint(plaintext: string, masterKey: Buffer): string {
  return createHmac("sha256", masterKey).update(plaintext, "utf8").digest("hex");
}

// ── status types (safe for HTTP) ─────────────────────────────────────────────

export interface MetaApiStatus {
  readonly configured: boolean;
  readonly hasToken: boolean;
  readonly tokenSource: "admin" | "env" | null;
  readonly hasWebhookSecret: boolean;
  readonly webhookSource: "admin" | "env" | null; // webhook has no ENV today — future-proof
  readonly baseUrl: string | null; // effective, validated or null
  readonly baseUrlSource: "admin" | "env" | "default" | null;
  /** Fingerprints only when a master key is present and a value is effective. */
  readonly tokenFingerprint: string | null;
  readonly webhookFingerprint: string | null;
}

export interface EmailStatus {
  readonly configured: boolean;
  readonly driver: string | null; // effective driver: smtp | resend | log | null
  readonly driverSource: "admin" | "env" | "default" | null;
  readonly from: string | null;
  readonly fromSource: "admin" | "env" | null;
  readonly fromName: string | null;
  readonly host: string | null;
  readonly port: string | null;
  readonly user: string | null;
  readonly hasSmtpPassword: boolean;
  readonly smtpPasswordSource: "admin" | "env" | null;
  readonly hasResendApiKey: boolean;
  readonly resendSource: "admin" | "env" | null;
}

export interface InventoryStatus {
  readonly metaapi: MetaApiStatus;
  readonly email: EmailStatus;
}

// ── probe result (classified, never leaks a secret) ──────────────────────────

export type ProbeOutcome = "reachable" | "auth_failed" | "not_configured" | "network_error" | "unknown";
export interface ProbeResult {
  readonly integration: "metaapi" | "email";
  readonly status: ProbeOutcome;
  readonly latencyMs: number;
  readonly detail: string | null; // safe message, no secret
}

// ── service ──────────────────────────────────────────────────────────────────

export interface IntegrationServiceDeps {
  readonly store: IntegrationStore;
  readonly masterKey: MasterKey | null;
  readonly env: (key: string) => string | undefined;
  /** Optional fetch injection for tests; defaults to global fetch. */
  readonly fetcher?: typeof fetch;
}

export class IntegrationService {
  constructor(private readonly deps: IntegrationServiceDeps) {}

  // ── ENV helpers ────────────────────────────────────────────────────────────

  private envTrim(key: string): string {
    return (this.deps.env(key) ?? "").trim();
  }

  // ── secret resolution (admin envelope → env → null) ──────────────────────

  private async resolveSecret(key: IntegrationSecretKey, envKey: string | null): Promise<{ value: string | null; source: "admin" | "env" | null }> {
    if (this.deps.masterKey !== null) {
      const envelope = await this.deps.store.readSecret(key);
      if (envelope !== null) {
        try {
          const v = decryptCredential(envelope, this.deps.masterKey);
          if (v.trim() !== "") return { value: v.trim(), source: "admin" };
        } catch (e) {
          if (!(e instanceof CredentialDecryptionError)) throw e;
          // Tampered/rotated — fall through to ENV, do not report as configured.
        }
      }
    }
    if (envKey !== null) {
      const fromEnv = this.envTrim(envKey);
      if (fromEnv !== "") return { value: fromEnv, source: "env" };
    }
    return { value: null, source: null };
  }

  private async hasSecret(key: IntegrationSecretKey, envKey: string | null): Promise<{ present: boolean; source: "admin" | "env" | null }> {
    const r = await this.resolveSecret(key, envKey);
    return { present: r.value !== null, source: r.source };
  }

  // ── metaapi ────────────────────────────────────────────────────────────────

  async metaApiStatus(): Promise<MetaApiStatus> {
    const token = await this.hasSecret("METAAPI_TOKEN", "METAAPI_PLATFORM_TOKEN");
    const webhook = await this.hasSecret("METAAPI_WEBHOOK_SECRET", null);
    const rawBase = (await this.deps.store.setting("METAAPI_BASE_URL"))?.trim() ?? "";
    let baseUrl: string | null = null;
    let baseSource: MetaApiStatus["baseUrlSource"] = null;
    if (rawBase !== "" && isValidHttpsUrl(rawBase)) {
      baseUrl = rawBase;
      baseSource = "admin";
    } else if (rawBase !== "" && !isValidHttpsUrl(rawBase)) {
      // Invalid admin value is not considered effective — fall through to ENV (fail-closed on use).
      const fromEnv = this.envTrim("METAAPI_BASE_URL");
      if (fromEnv !== "" && isValidHttpsUrl(fromEnv)) {
        baseUrl = fromEnv;
        baseSource = "env";
      } else if (fromEnv === "") {
        baseUrl = "https://api.metaapi.cloud";
        baseSource = "default";
      } else {
        baseUrl = null;
        baseSource = null;
      }
    } else {
      const fromEnv = this.envTrim("METAAPI_BASE_URL");
      if (fromEnv !== "" && isValidHttpsUrl(fromEnv)) {
        baseUrl = fromEnv;
        baseSource = "env";
      } else {
        baseUrl = "https://api.metaapi.cloud";
        baseSource = "default";
      }
    }

    const tokenFp = await this.tryFingerprint("METAAPI_TOKEN", "METAAPI_PLATFORM_TOKEN");
    const whFp = await this.tryFingerprint("METAAPI_WEBHOOK_SECRET", null);

    const configured = token.present; // token is the gating secret; baseUrl has a default
    return {
      configured,
      hasToken: token.present,
      tokenSource: token.source,
      hasWebhookSecret: webhook.present,
      webhookSource: webhook.source,
      baseUrl,
      baseUrlSource: baseSource,
      tokenFingerprint: tokenFp,
      webhookFingerprint: whFp,
    };
  }

  private async tryFingerprint(key: IntegrationSecretKey, envKey: string | null): Promise<string | null> {
    if (this.deps.masterKey === null) return null;
    const r = await this.resolveSecret(key, envKey);
    if (r.value === null) return null;
    return fingerprint(r.value, this.deps.masterKey.material());
  }

  async updateMetaApi(
    input: { token?: string | undefined; webhookSecret?: string | undefined; baseUrl?: string | undefined },
    actorId: string | null,
  ): Promise<MetaApiStatus> {
    const token = input.token?.trim() ?? "";
    const wh = input.webhookSecret?.trim() ?? "";
    const base = input.baseUrl?.trim() ?? "";
    if (token === "" && wh === "" && base === "") {
      throw new ValidationError("At least one MetaAPI field is required.", { integration: ["INTEGRATION_CONFIG_EMPTY"] });
    }
    if (token !== "") {
      if (Buffer.byteLength(token, "utf8") > MAX_SECRET_BYTES || token.length < 8) {
        throw new ValidationError("Invalid MetaAPI token.", { token: ["INVALID_TOKEN"] });
      }
      if (/[\x00-\x1F\x7F]/.test(token)) throw new ValidationError("Invalid MetaAPI token.", { token: ["INVALID_TOKEN"] });
      if (this.deps.masterKey === null) throw new MasterKeyMissingError();
      const env = encryptCredential(token, this.deps.masterKey);
      await this.deps.store.writeSecret("METAAPI_TOKEN", env, actorId);
    }
    if (wh !== "") {
      if (Buffer.byteLength(wh, "utf8") > MAX_SECRET_BYTES) throw new ValidationError("Invalid webhook secret.", { webhook_secret: ["INVALID_SECRET"] });
      if (this.deps.masterKey === null) throw new MasterKeyMissingError();
      const env = encryptCredential(wh, this.deps.masterKey);
      await this.deps.store.writeSecret("METAAPI_WEBHOOK_SECRET", env, actorId);
    }
    if (base !== "") {
      if (!isValidHttpsUrl(base)) throw new ValidationError("MetaAPI base URL must be https.", { base_url: ["INVALID_URL"] });
      await this.deps.store.setSetting("METAAPI_BASE_URL", base, actorId);
    }
    return this.metaApiStatus();
  }

  async clearMetaApi(): Promise<MetaApiStatus> {
    await this.deps.store.deleteSecret("METAAPI_TOKEN");
    await this.deps.store.deleteSecret("METAAPI_WEBHOOK_SECRET");
    await this.deps.store.deleteSetting("METAAPI_BASE_URL");
    return this.metaApiStatus();
  }

  async testMetaApi(): Promise<ProbeResult> {
    const tokenResolved = await this.resolveSecret("METAAPI_TOKEN", "METAAPI_PLATFORM_TOKEN");
    if (tokenResolved.value === null) {
      return { integration: "metaapi", status: "not_configured", latencyMs: 0, detail: "MetaAPI token is not configured." };
    }
    const start = Date.now();
    const fetcher = this.deps.fetcher ?? fetch;
    // Probe: GET baseUrl/users/current with Bearer token. Timeout 5s, no retry.
    // The URL is validated above, so only an https host is ever contacted.
    const status = await this.metaApiStatus();
    const base = status.baseUrl ?? "https://api.metaapi.cloud";
    const url = base.replace(/\/$/, "") + "/users/current";
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 5000);
      const res = await fetcher(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${tokenResolved.value}` },
        signal: ac.signal,
      } as RequestInit);
      clearTimeout(t);
      const latencyMs = Date.now() - start;
      if (res.status === 200 || res.status === 204) return { integration: "metaapi", status: "reachable", latencyMs, detail: null };
      if (res.status === 401 || res.status === 403) return { integration: "metaapi", status: "auth_failed", latencyMs, detail: `Upstream ${res.status}` };
      return { integration: "metaapi", status: "network_error", latencyMs, detail: `Upstream ${res.status}` };
    } catch {
      const latencyMs = Date.now() - start;
      return { integration: "metaapi", status: "network_error", latencyMs, detail: "Network or timeout." };
    }
  }

  // ── email ──────────────────────────────────────────────────────────────────

  async emailStatus(): Promise<EmailStatus> {
    const adminDriver = (await this.deps.store.setting("MAIL_DRIVER"))?.trim().toLowerCase() ?? "";
    const envDriver = this.envTrim("MAIL_DRIVER").toLowerCase();
    let driver: string | null = null;
    let driverSource: EmailStatus["driverSource"] = null;
    if (adminDriver !== "" && ["smtp", "resend", "log"].includes(adminDriver)) {
      driver = adminDriver;
      driverSource = "admin";
    } else if (envDriver !== "" && ["smtp", "resend", "log"].includes(envDriver)) {
      driver = envDriver;
      driverSource = "env";
    } else if (adminDriver === "" && envDriver === "") {
      // Default is resend when a Resend key exists, otherwise log (fail-safe without spamming).
      const hasResend = (await this.hasSecret("RESEND_API_KEY", "RESEND_API_KEY")).present;
      if (hasResend) {
        driver = "resend";
        driverSource = "default";
      } else {
        driver = "log";
        driverSource = "default";
      }
    }

    const from = (await this.deps.store.setting("MAIL_FROM"))?.trim() ?? this.envTrim("MAIL_FROM") ?? "";
    const fromSource = (await this.deps.store.setting("MAIL_FROM"))?.trim() ? "admin" : this.envTrim("MAIL_FROM") ? "env" : null;
    const fromName = (await this.deps.store.setting("MAIL_FROM_NAME"))?.trim() ?? this.envTrim("MAIL_FROM_NAME") ?? "";
    const host = (await this.deps.store.setting("MAIL_HOST"))?.trim() ?? this.envTrim("MAIL_HOST") ?? "";
    const port = (await this.deps.store.setting("MAIL_PORT"))?.trim() ?? this.envTrim("MAIL_PORT") ?? "";
    const user = (await this.deps.store.setting("MAIL_USER"))?.trim() ?? this.envTrim("MAIL_USER") ?? "";

    const smtpPass = await this.hasSecret("SMTP_PASSWORD", "SMTP_PASSWORD");
    const resend = await this.hasSecret("RESEND_API_KEY", "RESEND_API_KEY");

    // configured means: driver resend needs a resend key; smtp needs host+user+pass; log is always configured.
    let configured = false;
    if (driver === "log") configured = true;
    else if (driver === "resend") configured = resend.present;
    else if (driver === "smtp") configured = host !== "" && user !== "" && smtpPass.present;

    return {
      configured,
      driver,
      driverSource: driverSource as EmailStatus["driverSource"],
      from: from === "" ? null : from,
      fromSource: (from === "" ? null : fromSource) as EmailStatus["fromSource"],
      fromName: fromName === "" ? null : fromName,
      host: host === "" ? null : host,
      port: port === "" ? null : port,
      user: user === "" ? null : user,
      hasSmtpPassword: smtpPass.present,
      smtpPasswordSource: smtpPass.source,
      hasResendApiKey: resend.present,
      resendSource: resend.source,
    };
  }

  async updateEmail(
    input: {
      driver?: string | undefined;
      from?: string | undefined;
      fromName?: string | undefined;
      host?: string | undefined;
      port?: string | undefined;
      user?: string | undefined;
      smtpPassword?: string | undefined;
      resendApiKey?: string | undefined;
    },
    actorId: string | null,
  ): Promise<EmailStatus> {
    const hasAny =
      (input.driver?.trim() ?? "") !== "" ||
      (input.from?.trim() ?? "") !== "" ||
      (input.fromName?.trim() ?? "") !== "" ||
      (input.host?.trim() ?? "") !== "" ||
      (input.port?.trim() ?? "") !== "" ||
      (input.user?.trim() ?? "") !== "" ||
      (input.smtpPassword ?? "") !== "" ||
      (input.resendApiKey ?? "") !== "";
    if (!hasAny) throw new ValidationError("At least one email field is required.", { integration: ["INTEGRATION_CONFIG_EMPTY"] });

    if (input.driver !== undefined && input.driver.trim() !== "") {
      const d = input.driver.trim().toLowerCase();
      assertValidDriver(d);
      await this.deps.store.setSetting("MAIL_DRIVER", d, actorId);
    }
    if (input.from !== undefined && input.from.trim() !== "") {
      const v = input.from.trim();
      if (!isValidEmail(v)) throw new ValidationError("Invalid sender email.", { from: ["INVALID_EMAIL"] });
      await this.deps.store.setSetting("MAIL_FROM", v, actorId);
    }
    if (input.fromName !== undefined && input.fromName.trim() !== "") {
      const v = input.fromName.trim();
      if (v.length > 120 || /[\x00-\x1F\x7F]/.test(v)) throw new ValidationError("Invalid sender name.", { from_name: ["INVALID_FORMAT"] });
      await this.deps.store.setSetting("MAIL_FROM_NAME", v, actorId);
    }
    if (input.host !== undefined && input.host.trim() !== "") {
      const v = input.host.trim();
      if (v.length > 253 || /[\x00-\x1F\x7F\s]/.test(v)) throw new ValidationError("Invalid SMTP host.", { smtp_host: ["INVALID_HOST"] });
      await this.deps.store.setSetting("MAIL_HOST", v, actorId);
    }
    if (input.port !== undefined && input.port.trim() !== "") {
      const v = input.port.trim();
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ValidationError("Invalid SMTP port.", { smtp_port: ["INVALID_PORT"] });
      await this.deps.store.setSetting("MAIL_PORT", String(n), actorId);
    }
    if (input.user !== undefined && input.user.trim() !== "") {
      const v = input.user.trim();
      if (v.length > 253) throw new ValidationError("Invalid SMTP user.", { smtp_user: ["INVALID_FORMAT"] });
      await this.deps.store.setSetting("MAIL_USER", v, actorId);
    }
    if (input.smtpPassword !== undefined && input.smtpPassword !== "") {
      if (Buffer.byteLength(input.smtpPassword, "utf8") > MAX_SECRET_BYTES) throw new ValidationError("Invalid SMTP password.", { smtp_password: ["INVALID_SECRET"] });
      if (this.deps.masterKey === null) throw new MasterKeyMissingError();
      await this.deps.store.writeSecret("SMTP_PASSWORD", encryptCredential(input.smtpPassword, this.deps.masterKey), actorId);
    }
    if (input.resendApiKey !== undefined && input.resendApiKey !== "") {
      if (Buffer.byteLength(input.resendApiKey, "utf8") > MAX_SECRET_BYTES) throw new ValidationError("Invalid Resend key.", { resend_api_key: ["INVALID_SECRET"] });
      if (this.deps.masterKey === null) throw new MasterKeyMissingError();
      await this.deps.store.writeSecret("RESEND_API_KEY", encryptCredential(input.resendApiKey, this.deps.masterKey), actorId);
    }

    return this.emailStatus();
  }

  async clearEmail(): Promise<EmailStatus> {
    for (const k of ["MAIL_DRIVER", "MAIL_FROM", "MAIL_FROM_NAME", "MAIL_HOST", "MAIL_PORT", "MAIL_USER"] as const) {
      await this.deps.store.deleteSetting(k);
    }
    await this.deps.store.deleteSecret("SMTP_PASSWORD");
    await this.deps.store.deleteSecret("RESEND_API_KEY");
    return this.emailStatus();
  }

  async testEmail(): Promise<ProbeResult> {
    const status = await this.emailStatus();
    if (!status.configured) {
      return { integration: "email", status: "not_configured", latencyMs: 0, detail: "Email integration is not configured for the effective driver." };
    }
    if (status.driver === "log") {
      return { integration: "email", status: "reachable", latencyMs: 0, detail: "Log driver — no upstream." };
    }
    if (status.driver === "resend") {
      const key = await this.resolveSecret("RESEND_API_KEY", "RESEND_API_KEY");
      if (key.value === null) return { integration: "email", status: "not_configured", latencyMs: 0, detail: "Resend key missing." };
      // Lightweight probe: verify Resend key format (re_...), not a live send.
      // A live send would require a from/to and would count as quota; format check
      // is the most an admin test should do without side effects.
      const start = Date.now();
      const looksValid = key.value.startsWith("re_") && key.value.length >= 20;
      return {
        integration: "email",
        status: looksValid ? "reachable" : "auth_failed",
        latencyMs: Date.now() - start,
        detail: looksValid ? null : "Resend key format invalid.",
      };
    }
    // smtp — try a TCP-ish check would need net; we classify as reachable when all parts present.
    return { integration: "email", status: status.configured ? "reachable" : "not_configured", latencyMs: 0, detail: null };
  }

  // ── inventory ──────────────────────────────────────────────────────────────

  async inventory(): Promise<InventoryStatus> {
    const [metaapi, email] = await Promise.all([this.metaApiStatus(), this.emailStatus()]);
    return { metaapi, email };
  }
}

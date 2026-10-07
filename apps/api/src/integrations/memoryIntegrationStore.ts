// In-memory double of IntegrationStore — contract-identical, no database.
import type { IntegrationSecretKey, IntegrationStore, SecretEnvelope } from "./integrationStore.js";

export class MemoryIntegrationStore implements IntegrationStore {
  private readonly secrets = new Map<IntegrationSecretKey, SecretEnvelope>();
  private readonly settings = new Map<string, string | null>();

  async readSecret(key: IntegrationSecretKey): Promise<SecretEnvelope | null> {
    return this.secrets.get(key) ?? null;
  }
  async writeSecret(key: IntegrationSecretKey, envelope: SecretEnvelope): Promise<void> {
    this.secrets.set(key, envelope);
  }
  async deleteSecret(key: IntegrationSecretKey): Promise<boolean> {
    return this.secrets.delete(key);
  }
  async secretKeysPresent(): Promise<IntegrationSecretKey[]> {
    return [...this.secrets.keys()].sort() as IntegrationSecretKey[];
  }
  async hasSecret(key: IntegrationSecretKey): Promise<boolean> {
    return this.secrets.has(key);
  }
  async setting(key: string): Promise<string | null> {
    return this.settings.has(key) ? this.settings.get(key) ?? null : null;
  }
  async setSetting(key: string, value: string | null): Promise<void> {
    this.settings.set(key, value);
  }
  async deleteSetting(key: string): Promise<boolean> {
    return this.settings.delete(key);
  }
  async allSettings(): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    for (const [k, v] of this.settings) out[k] = v;
    return out;
  }
}

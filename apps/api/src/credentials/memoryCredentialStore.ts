// In-memory CredentialStore (tests and local development).
//
// Mirrors the database contract exactly, including the security-relevant
// parts: rows hold the ENCRYPTED envelope (never plaintext), reads are
// owner-scoped, and (user, provider) uniqueness is enforced. Storing plaintext
// here "because it is only a test adapter" would make the ciphertext-at-rest
// tests meaningless, so the same encryption path is used.
import type { QueryFn } from "../persistence/pg.js";
import type { CredentialAuditWrite } from "./credentialStore.js";
import {
  type CredentialRecord,
  type CredentialStore,
  type CredentialWrite,
  CredentialAlreadyExistsError,
} from "./credentialStore.js";
import {
  decryptCredential,
  encryptCredential,
  type CredentialEnvelope,
  type MasterKey,
} from "./credentialCrypto.js";

interface StoredCredential {
  readonly record: CredentialRecord;
  readonly envelope: CredentialEnvelope;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly rows = new Map<string, StoredCredential>();
  private seq = 0;

  constructor(private readonly key: MasterKey) {}

  async create(
    input: CredentialWrite,
    _tx?: QueryFn,
    audit?: CredentialAuditWrite,
  ): Promise<CredentialRecord> {
    for (const r of this.rows.values()) {
      if (r.record.userId === input.userId && r.record.provider === input.provider) {
        throw new CredentialAlreadyExistsError();
      }
    }
    const envelope = encryptCredential(input.secret, this.key);
    this.seq += 1;
    const record: CredentialRecord = {
      id: String(this.seq),
      userId: input.userId,
      provider: input.provider,
      keyVersion: envelope.keyVersion,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
    };
    // C-34 atomicity, in-memory equivalent: the audit write runs BEFORE the
    // map is mutated, so if it throws the store is left untouched — the same
    // observable outcome as the PG adapter's ROLLBACK.
    if (audit !== undefined) await audit(undefined, record);
    this.rows.set(record.id, { record, envelope });
    return record;
  }

  async list(userId: string): Promise<readonly CredentialRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.record.userId === userId)
      .map((r) => r.record)
      .reverse();
  }

  async findById(id: string, userId: string): Promise<CredentialRecord | null> {
    const row = this.rows.get(id);
    if (row === undefined || row.record.userId !== userId) return null;
    return row.record;
  }

  async reveal(id: string, userId: string): Promise<string | null> {
    const row = this.rows.get(id);
    // Ownership mismatch is indistinguishable from "absent".
    if (row === undefined || row.record.userId !== userId) return null;
    return decryptCredential(row.envelope, this.key);
  }

  async delete(
    id: string,
    userId: string,
    _tx?: QueryFn,
    audit?: CredentialAuditWrite,
  ): Promise<boolean> {
    const row = this.rows.get(id);
    // Ownership mismatch is indistinguishable from "absent", and neither
    // produces an audit record: nothing happened.
    if (row === undefined || row.record.userId !== userId) return false;
    // Audit first: a throw here leaves the credential in place, mirroring
    // ROLLBACK.
    if (audit !== undefined) await audit(undefined, row.record);
    this.rows.delete(id);
    return true;
  }

  /** Test-only: the raw stored envelope, for ciphertext-at-rest assertions. */
  rawEnvelope(id: string): CredentialEnvelope | undefined {
    return this.rows.get(id)?.envelope;
  }
}

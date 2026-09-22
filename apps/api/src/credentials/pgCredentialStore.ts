// PgCredentialStore — the real-PostgreSQL CredentialStore adapter (C-22).
//
// CIPHERTEXT AT REST: the INSERT writes only the encrypted envelope. There is
// no plaintext column in user_credentials and no statement here that could
// write one. Encryption happens in this adapter, before the SQL runs, so no
// caller can bypass it.
//
// ERROR SAFETY: a failing INSERT/SELECT must never surface secret material.
// Query parameters are passed as bound values (never interpolated into SQL
// text), so a driver error message cannot contain the plaintext. Decryption
// failures are re-thrown as the uniform CredentialDecryptionError.
import type { Pool } from "pg";
import { poolQuery, iso, isUniqueViolation, withTransaction, type QueryFn } from "../persistence/pg.js";
import type { CredentialAuditWrite } from "./credentialStore.js";
import {
  type CredentialProvider,
  type CredentialRecord,
  type CredentialStore,
  type CredentialWrite,
  CredentialAlreadyExistsError,
} from "./credentialStore.js";
import {
  decryptCredential,
  encryptCredential,
  type MasterKey,
  CREDENTIAL_ALGORITHM,
} from "./credentialCrypto.js";

interface CredentialRow {
  id: string | number;
  user_id: string | number;
  provider: string;
  enc_version: number;
  key_version: number;
  algorithm: string;
  iv: Buffer;
  auth_tag: Buffer;
  secret_ciphertext: Buffer;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Map to METADATA only — deliberately drops every envelope/secret column. */
function mapMetadata(r: CredentialRow): CredentialRecord {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    provider: r.provider as CredentialProvider,
    keyVersion: Number(r.key_version),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const METADATA_COLUMNS =
  "id, user_id, provider, enc_version, key_version, algorithm, created_at, updated_at";

export class PgCredentialStore implements CredentialStore {
  private readonly q: QueryFn;

  constructor(
    private readonly pool: Pool,
    private readonly key: MasterKey,
  ) {
    this.q = poolQuery(pool);
  }

  async create(
    input: CredentialWrite,
    tx?: QueryFn,
    audit?: CredentialAuditWrite,
  ): Promise<CredentialRecord> {
    // B-3 atomicity: with an audit callback and no caller-supplied transaction,
    // this store opens ONE transaction covering the INSERT and the audit row.
    // If the audit write throws, withTransaction issues ROLLBACK and no
    // credential exists without its audit record. An externally supplied `tx`
    // is reused as-is, so a larger caller transaction still governs atomicity.
    if (audit !== undefined && tx === undefined) {
      return withTransaction(this.pool, async (q) => this.createWith(q, input, audit));
    }
    return this.createWith(tx ?? this.q, input, audit);
  }

  private async createWith(
    run: QueryFn,
    input: CredentialWrite,
    audit?: CredentialAuditWrite,
  ): Promise<CredentialRecord> {
    // Encrypt BEFORE touching the database: if this throws, nothing is written.
    const env = encryptCredential(input.secret, this.key);
    try {
      const rows = await run(
        `INSERT INTO user_credentials
           (user_id, provider, enc_version, key_version, algorithm,
            iv, auth_tag, secret_ciphertext, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
         RETURNING ${METADATA_COLUMNS}`,
        [
          input.userId,
          input.provider,
          env.version,
          env.keyVersion,
          env.algorithm,
          env.iv,
          env.authTag,
          env.ciphertext,
          input.now,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error("credential create: INSERT returned no row");
      const record = mapMetadata(row as unknown as CredentialRow);
      // Inside the same transaction: an audit failure rolls the INSERT back.
      // Errors propagate deliberately — never caught, never ignored.
      if (audit !== undefined) await audit(run, record);
      return record;
    } catch (err: unknown) {
      // (user, provider) uniqueness -> an explicit domain error. The original
      // driver error is not propagated, so nothing it carries can leak.
      if (isUniqueViolation(err)) throw new CredentialAlreadyExistsError();
      throw err;
    }
  }

  async list(userId: string): Promise<readonly CredentialRecord[]> {
    // Selects metadata columns ONLY — the ciphertext never leaves the DB here.
    const rows = await this.q(
      `SELECT ${METADATA_COLUMNS} FROM user_credentials
        WHERE user_id = $1 ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    return rows.map((r) => mapMetadata(r as unknown as CredentialRow));
  }

  async findById(id: string, userId: string): Promise<CredentialRecord | null> {
    const rows = await this.q(
      `SELECT ${METADATA_COLUMNS} FROM user_credentials WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows.length === 0 ? null : mapMetadata(rows[0] as unknown as CredentialRow);
  }

  async reveal(id: string, userId: string): Promise<string | null> {
    // Owner-scoped by SQL: another user's row is simply not selected.
    const rows = await this.q(
      `SELECT enc_version, key_version, algorithm, iv, auth_tag, secret_ciphertext
         FROM user_credentials WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (rows.length === 0) return null;
    const r = rows[0] as unknown as CredentialRow;
    return decryptCredential(
      {
        version: Number(r.enc_version),
        keyVersion: Number(r.key_version),
        algorithm: r.algorithm as typeof CREDENTIAL_ALGORITHM,
        iv: r.iv,
        ciphertext: r.secret_ciphertext,
        authTag: r.auth_tag,
      },
      this.key,
    );
  }

  async delete(
    id: string,
    userId: string,
    tx?: QueryFn,
    audit?: CredentialAuditWrite,
  ): Promise<boolean> {
    if (audit !== undefined && tx === undefined) {
      return withTransaction(this.pool, async (q) => this.deleteWith(q, id, userId, audit));
    }
    return this.deleteWith(tx ?? this.q, id, userId, audit);
  }

  private async deleteWith(
    run: QueryFn,
    id: string,
    userId: string,
    audit?: CredentialAuditWrite,
  ): Promise<boolean> {
    // RETURNING the full metadata (not just id) so the audit row can record
    // `provider` for a row that no longer exists. Reading it in a separate
    // statement before the DELETE would be a race; RETURNING is atomic with
    // the deletion itself.
    const rows = await run(
      `DELETE FROM user_credentials WHERE id = $1 AND user_id = $2
       RETURNING ${METADATA_COLUMNS}`,
      [id, userId],
    );
    const row = rows[0];
    if (row === undefined) return false; // absent or not owned -> no audit row
    if (audit !== undefined) await audit(run, mapMetadata(row as unknown as CredentialRow));
    return true;
  }
}

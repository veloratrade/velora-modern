// AttachmentService — v0.5 "screenshot upload" (≤ 5 MB, MIME whitelist).
//
// ============================================================
// WHAT THE PRODUCT NEEDS
// ============================================================
// A trader attaches a chart screenshot to a trade (before/after/other), can see
// it again later, and can delete it. The rules are small and exact; the risky
// part is the BYTES, not the metadata.
//
// ============================================================
// RULES (roadmap v0.5 — `docs/pdf/Roadmap.pdf` @ legacy `edede31`; legacy
// extraction lives in `api/src/Trades/ScreenshotExtractController.php` +
// `api/src/AI/Extraction/ScreenshotExtractor.php`. Citation corrected
// 2026-09-26: the previously cited `ScreenshotController.php` does not exist
// in the legacy repository — audit §5 / §16.3 D4 / MG-DOC-4.)
// ============================================================
//   - accepted MIME: image/jpeg, image/png, image/webp  (hard whitelist)
//   - maximum size: 5 242 880 bytes (5 MiB), zero-byte uploads refused
//   - categories: BEFORE | AFTER | OTHER
//   - a file name is required, ≤ 255 characters, stored WITHOUT any path
//   - ownership of the trade is required to attach, read or delete
//   - deleting an attachment is SOFT (the row keeps `deleted_at`) so an audit of
//     what was attached survives; the stored object is removed separately.
// The limits above are ALSO enforced by 0015's CHECK constraints. Validation
// here exists to return a precise 4xx; the constraint remains the authority.
//
// ============================================================
// STORAGE — A DOCUMENTED, PORT-BOUNDED DIVERGENCE
// ============================================================
// `trade_attachments.storage_key` (0015) presumes an OBJECT STORE: a key, not a
// blob column. No object-store integration (S3/R2/GCS) exists anywhere in this
// repository, and inventing bucket names, endpoints or credentials would be
// inventing an Owner requirement — which the migration brief forbids.
//
// So the capability is implemented against a `AttachmentStorage` PORT with a
// working local-filesystem adapter for staging and tests, and the production
// object store is reported as an OWNER_DECISION_REQUIRED item. The service,
// validation, ownership, soft-delete and API surface are complete and proven;
// only the concrete byte sink is deferred. Nothing here pretends the local
// adapter is production storage.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { QueryFn } from "../persistence/pg.js";

export const MAX_ATTACHMENT_BYTES = 5_242_880; // 5 MiB, roadmap limit
export const ALLOWED_MIME: readonly string[] = ["image/jpeg", "image/png", "image/webp"];
export const CATEGORIES: readonly string[] = ["BEFORE", "AFTER", "OTHER"];

export interface AttachmentRecord {
  readonly id: string;
  readonly tradeId: string;
  readonly category: string;
  readonly fileName: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string | null;
  readonly createdAt: string;
}

export class AttachmentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AttachmentError";
  }
}

/** Byte sink. `key` is opaque and must be safe to embed in a path. */
export interface AttachmentStorage {
  readonly name: string;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

/**
 * Local-filesystem adapter — for staging and tests ONLY.
 *
 * It is intentionally NOT registered by default in `server-main.ts` unless
 * `ATTACHMENT_STORAGE_DIR` is set, so a deployment cannot silently acquire a
 * disk-backed attachment store it did not ask for. Container filesystems are
 * ephemeral: this is not production storage and is reported as such.
 */
export class LocalAttachmentStorage implements AttachmentStorage {
  readonly name = "local-disk";

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    // Keys are server-generated (`<uuid>`), but the guard is kept anyway: a path
    // traversal through a storage key would be a filesystem escape.
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) throw new AttachmentError(500, "STORAGE_KEY_INVALID", "Invalid storage key.");
    return join(this.root, key);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.resolve(key), bytes);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

/** In-memory sink for service/route tests. Not persistence evidence. */
export class MemoryAttachmentStorage implements AttachmentStorage {
  readonly name = "memory";
  readonly #objects = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer): Promise<void> {
    this.#objects.set(key, Buffer.from(bytes));
  }
  async get(key: string): Promise<Buffer | null> {
    return this.#objects.get(key) ?? null;
  }
  async remove(key: string): Promise<void> {
    this.#objects.delete(key);
  }
}

export interface AttachmentStore {
  listForTrade(userId: string, tradeId: string): Promise<AttachmentRecord[]>;
  find(userId: string, attachmentId: string): Promise<(AttachmentRecord & { storageKey: string }) | null>;
  insert(input: {
    tradeId: string;
    userId: string;
    category: string;
    fileName: string;
    mime: string;
    sizeBytes: number;
    storageKey: string;
    checksumSha256: string;
  }): Promise<AttachmentRecord>;
  softDelete(userId: string, attachmentId: string): Promise<boolean>;
  tradeOwnedBy(userId: string, tradeId: string): Promise<boolean>;
}

type Row = Record<string, unknown>;

function mapAttachment(row: Row): AttachmentRecord {
  return {
    id: String(row["id"]),
    tradeId: String(row["trade_id"]),
    category: String(row["category"]),
    fileName: String(row["file_name"]),
    mime: String(row["mime"]),
    sizeBytes: Number(row["size_bytes"]),
    checksumSha256: row["checksum_sha256"] === null ? null : String(row["checksum_sha256"]),
    createdAt: row["created_at"] instanceof Date ? (row["created_at"] as Date).toISOString() : String(row["created_at"]),
  };
}

const COLS = "id, trade_id, category, file_name, mime, size_bytes, checksum_sha256, created_at";

export class PgAttachmentStore implements AttachmentStore {
  constructor(private readonly q: QueryFn) {}

  async listForTrade(userId: string, tradeId: string): Promise<AttachmentRecord[]> {
    const rows = await this.q(
      `SELECT ${COLS} FROM trade_attachments
        WHERE user_id = $1 AND trade_id = $2 AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC`,
      [userId, tradeId],
    );
    return rows.map(mapAttachment);
  }

  async find(userId: string, attachmentId: string): Promise<(AttachmentRecord & { storageKey: string }) | null> {
    const rows = await this.q(
      `SELECT ${COLS}, storage_key FROM trade_attachments
        WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [userId, attachmentId],
    );
    const row = rows[0];
    return row === undefined ? null : { ...mapAttachment(row), storageKey: String(row["storage_key"]) };
  }

  async insert(input: {
    tradeId: string;
    userId: string;
    category: string;
    fileName: string;
    mime: string;
    sizeBytes: number;
    storageKey: string;
    checksumSha256: string;
  }): Promise<AttachmentRecord> {
    const rows = await this.q(
      `INSERT INTO trade_attachments
         (trade_id, user_id, category, file_name, mime, size_bytes, storage_key, checksum_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLS}`,
      [
        input.tradeId,
        input.userId,
        input.category,
        input.fileName,
        input.mime,
        input.sizeBytes,
        input.storageKey,
        input.checksumSha256,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new AttachmentError(500, "ATTACHMENT_CREATE_FAILED", "Attachment could not be recorded.");
    return mapAttachment(row);
  }

  async softDelete(userId: string, attachmentId: string): Promise<boolean> {
    const rows = await this.q(
      `UPDATE trade_attachments SET deleted_at = now()
        WHERE user_id = $1 AND id = $2 AND deleted_at IS NULL
        RETURNING id`,
      [userId, attachmentId],
    );
    return rows.length > 0;
  }

  async tradeOwnedBy(userId: string, tradeId: string): Promise<boolean> {
    const rows = await this.q("SELECT 1 FROM trades WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL", [
      tradeId,
      userId,
    ]);
    return rows.length > 0;
  }
}

/** In-memory double (contract-identical; not database evidence). */
export class MemoryAttachmentStore implements AttachmentStore {
  #seq = 0;
  readonly #rows = new Map<string, AttachmentRecord & { userId: string; storageKey: string; deleted: boolean }>();
  readonly #trades = new Set<string>();

  addTrade(userId: string, tradeId: string): void {
    this.#trades.add(`${userId}\u0000${tradeId}`);
  }

  async listForTrade(userId: string, tradeId: string): Promise<AttachmentRecord[]> {
    return [...this.#rows.values()]
      .filter((r) => r.userId === userId && r.tradeId === tradeId && !r.deleted)
      .map(({ userId: _u, storageKey: _k, deleted: _d, ...rest }) => rest);
  }

  async find(userId: string, attachmentId: string): Promise<(AttachmentRecord & { storageKey: string }) | null> {
    const r = this.#rows.get(attachmentId);
    if (r === undefined || r.userId !== userId || r.deleted) return null;
    const { userId: _u, deleted: _d, ...rest } = r;
    return rest;
  }

  async insert(input: {
    tradeId: string;
    userId: string;
    category: string;
    fileName: string;
    mime: string;
    sizeBytes: number;
    storageKey: string;
    checksumSha256: string;
  }): Promise<AttachmentRecord> {
    this.#seq += 1;
    const id = String(this.#seq);
    const record = {
      id,
      tradeId: input.tradeId,
      category: input.category,
      fileName: input.fileName,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      checksumSha256: input.checksumSha256,
      createdAt: new Date().toISOString(),
      userId: input.userId,
      storageKey: input.storageKey,
      deleted: false,
    };
    this.#rows.set(id, record);
    const { userId: _u, storageKey: _k, deleted: _d, ...rest } = record;
    return rest;
  }

  async softDelete(userId: string, attachmentId: string): Promise<boolean> {
    const r = this.#rows.get(attachmentId);
    if (r === undefined || r.userId !== userId || r.deleted) return false;
    this.#rows.set(attachmentId, { ...r, deleted: true });
    return true;
  }

  async tradeOwnedBy(userId: string, tradeId: string): Promise<boolean> {
    return this.#trades.has(`${userId}\u0000${tradeId}`);
  }
}

export interface UploadInput {
  readonly tradeId: string;
  readonly userId: string;
  readonly fileName: string;
  readonly mime: string;
  readonly category: string;
  readonly bytes: Buffer;
}

function validateFileName(raw: string): string {
  // Strip any client-supplied path: only the base name is stored. A name that is
  // empty after stripping, or longer than the 0015 limit, is refused rather
  // than truncated (truncation would silently collide two different files).
  const name = basename(raw.trim());
  if (name === "" || name === "." || name === "..") {
    throw new AttachmentError(400, "VALIDATION_FAILED", "file name is required.");
  }
  if (name.length > 255) throw new AttachmentError(400, "VALIDATION_FAILED", "file name must be at most 255 characters.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new AttachmentError(400, "VALIDATION_FAILED", "file name contains control characters.");
  return name;
}

export class AttachmentService {
  constructor(
    private readonly store: AttachmentStore,
    private readonly storage: AttachmentStorage,
  ) {}

  async list(userId: string, tradeId: string): Promise<AttachmentRecord[]> {
    return this.store.listForTrade(userId, tradeId);
  }

  /** Read the bytes back. Ownership comes from the store's (user, id) key. */
  async content(userId: string, attachmentId: string): Promise<{ record: AttachmentRecord; bytes: Buffer } | null> {
    const record = await this.store.find(userId, attachmentId);
    if (record === null) return null;
    const bytes = await this.storage.get(record.storageKey);
    if (bytes === null) {
      // Metadata without an object: a real inconsistency that must surface as
      // such rather than as an empty 200.
      throw new AttachmentError(500, "ATTACHMENT_OBJECT_MISSING", "Attachment content is unavailable.");
    }
    return { record, bytes };
  }

  async upload(input: UploadInput): Promise<AttachmentRecord> {
    const fileName = validateFileName(input.fileName);
    const mime = input.mime.trim().toLowerCase();
    if (!ALLOWED_MIME.includes(mime)) {
      throw new AttachmentError(422, "UNSUPPORTED_MEDIA_TYPE", `mime must be one of ${ALLOWED_MIME.join(", ")}.`);
    }
    const category = (input.category.trim() === "" ? "OTHER" : input.category.trim().toUpperCase());
    if (!CATEGORIES.includes(category)) {
      throw new AttachmentError(400, "VALIDATION_FAILED", `category must be one of ${CATEGORIES.join(", ")}.`);
    }
    const size = input.bytes.length;
    if (size === 0) throw new AttachmentError(400, "VALIDATION_FAILED", "file is empty.");
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentError(413, "PAYLOAD_TOO_LARGE", `file exceeds ${MAX_ATTACHMENT_BYTES} bytes.`);
    }

    const checksum = createHash("sha256").update(input.bytes).digest("hex");
    // The storage key is SERVER-generated. A client-supplied key would let a
    // caller choose where bytes land.
    const storageKey = `${randomUUID()}`;

    await this.storage.put(storageKey, input.bytes);
    try {
      return await this.store.insert({
        tradeId: input.tradeId,
        userId: input.userId,
        category,
        fileName,
        mime,
        sizeBytes: size,
        storageKey,
        checksumSha256: checksum,
      });
    } catch (err) {
      // The metadata row is the source of truth. If it cannot be written, the
      // object must not be left behind as an orphan.
      await this.storage.remove(storageKey);
      throw err;
    }
  }

  async remove(userId: string, attachmentId: string): Promise<boolean> {
    const record = await this.store.find(userId, attachmentId);
    if (record === null) return false;
    const deleted = await this.store.softDelete(userId, attachmentId);
    if (!deleted) return false;
    // Metadata first, bytes second: if the object removal fails, the row is
    // already marked deleted and the orphan is inert (never served, since every
    // read filters `deleted_at IS NULL`).
    await this.storage.remove(record.storageKey);
    return true;
  }

  async tradeOwnedBy(userId: string, tradeId: string): Promise<boolean> {
    return this.store.tradeOwnedBy(userId, tradeId);
  }
}

// TagService — v0.5 journal tags ("Analytics & Tagging").
//
// RULES EXTRACTED FROM LEGACY (`api/src/Trades/TagController.php` +
// `tag_assignments`): tags are PER-USER and private; names are unique per user;
// a tag has a kind from a fixed vocabulary; a colour is an optional `#RRGGBB`;
// assigning a tag to a trade requires owning BOTH the trade and the tag;
// assigning twice is a conflict, not a duplicate row.
//
// NOT CARRIED OVER: the Legacy `tag_assignments` table name. The Modern
// foundation calls it `trade_tags` (0015) and the migration does not resurrect
// the old name — the data model was already rationalised and legacy names are
// structural, not behavioural.
//
// THE DATABASE IS THE VALIDATOR OF LAST RESORT. Tag limits (name ≤ 60, kind
// vocabulary, colour format) and the (user_id, name) uniqueness are enforced by
// 0015's CHECK/UNIQUE constraints. This service pre-validates so the client gets
// a precise 400/409 instead of a 500, and then lets the constraint stand as the
// authority — it never "fixes up" a violating value.
import type { QueryFn } from "../persistence/pg.js";

export const TAG_KINDS = ["STRATEGY", "SETUP", "MISTAKE", "EMOTION", "CUSTOM"] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export interface TagRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: TagKind;
  readonly color: string | null;
}

export class TagError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TagError";
  }
}

export interface TagStore {
  list(userId: string): Promise<TagRecord[]>;
  create(userId: string, input: { name: string; kind: TagKind; color: string | null }): Promise<TagRecord>;
  find(userId: string, tagId: string): Promise<TagRecord | null>;
  remove(userId: string, tagId: string): Promise<boolean>;
  listForTrade(userId: string, tradeId: string): Promise<TagRecord[]>;
  assign(userId: string, tradeId: string, tagId: string): Promise<boolean>;
  unassign(userId: string, tradeId: string, tagId: string): Promise<boolean>;
  tradeOwnedBy(userId: string, tradeId: string): Promise<boolean>;
}

type Row = Record<string, unknown>;

function mapTag(row: Row): TagRecord {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    kind: String(row["kind"]) as TagKind,
    color: row["color"] === null ? null : String(row["color"]),
  };
}

export class PgTagStore implements TagStore {
  constructor(private readonly q: QueryFn) {}

  async list(userId: string): Promise<TagRecord[]> {
    const rows = await this.q(
      "SELECT id, name, kind, color FROM tags WHERE user_id = $1 ORDER BY kind ASC, name ASC",
      [userId],
    );
    return rows.map(mapTag);
  }

  async create(userId: string, input: { name: string; kind: TagKind; color: string | null }): Promise<TagRecord> {
    const rows = await this.q(
      "INSERT INTO tags (user_id, name, kind, color) VALUES ($1, $2, $3, $4) RETURNING id, name, kind, color",
      [userId, input.name, input.kind, input.color],
    );
    const row = rows[0];
    if (row === undefined) throw new TagError(500, "TAG_CREATE_FAILED", "Tag could not be created.");
    return mapTag(row);
  }

  async find(userId: string, tagId: string): Promise<TagRecord | null> {
    const rows = await this.q("SELECT id, name, kind, color FROM tags WHERE user_id = $1 AND id = $2", [
      userId,
      tagId,
    ]);
    const row = rows[0];
    return row === undefined ? null : mapTag(row);
  }

  async remove(userId: string, tagId: string): Promise<boolean> {
    const rows = await this.q("DELETE FROM tags WHERE user_id = $1 AND id = $2 RETURNING id", [userId, tagId]);
    return rows.length > 0;
  }

  async listForTrade(userId: string, tradeId: string): Promise<TagRecord[]> {
    const rows = await this.q(
      `SELECT g.id, g.name, g.kind, g.color
         FROM trade_tags tt
         JOIN tags g ON g.id = tt.tag_id
        WHERE tt.user_id = $1 AND tt.trade_id = $2
        ORDER BY g.kind ASC, g.name ASC`,
      [userId, tradeId],
    );
    return rows.map(mapTag);
  }

  async assign(userId: string, tradeId: string, tagId: string): Promise<boolean> {
    const rows = await this.q(
      `INSERT INTO trade_tags (trade_id, tag_id, user_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING tag_id`,
      [tradeId, tagId, userId],
    );
    return rows.length > 0;
  }

  async unassign(userId: string, tradeId: string, tagId: string): Promise<boolean> {
    const rows = await this.q(
      "DELETE FROM trade_tags WHERE user_id = $1 AND trade_id = $2 AND tag_id = $3 RETURNING tag_id",
      [userId, tradeId, tagId],
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
export class MemoryTagStore implements TagStore {
  #seq = 0;
  readonly #tags = new Map<string, TagRecord & { userId: string }>();
  readonly #links = new Set<string>();
  readonly #trades = new Set<string>();

  addTrade(userId: string, tradeId: string): void {
    this.#trades.add(`${userId}\u0000${tradeId}`);
  }

  async list(userId: string): Promise<TagRecord[]> {
    return [...this.#tags.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
      .map(({ id, name, kind, color }) => ({ id, name, kind, color }));
  }

  async create(userId: string, input: { name: string; kind: TagKind; color: string | null }): Promise<TagRecord> {
    for (const t of this.#tags.values()) {
      if (t.userId === userId && t.name === input.name) {
        throw new TagError(409, "TAG_NAME_TAKEN", "A tag with that name already exists.");
      }
    }
    this.#seq += 1;
    const record = { id: String(this.#seq), name: input.name, kind: input.kind, color: input.color, userId };
    this.#tags.set(record.id, record);
    return { id: record.id, name: record.name, kind: record.kind, color: record.color };
  }

  async find(userId: string, tagId: string): Promise<TagRecord | null> {
    const t = this.#tags.get(tagId);
    if (t === undefined || t.userId !== userId) return null;
    return { id: t.id, name: t.name, kind: t.kind, color: t.color };
  }

  async remove(userId: string, tagId: string): Promise<boolean> {
    const t = this.#tags.get(tagId);
    if (t === undefined || t.userId !== userId) return false;
    this.#tags.delete(tagId);
    return true;
  }

  async listForTrade(userId: string, tradeId: string): Promise<TagRecord[]> {
    const all = await this.list(userId);
    return all.filter((t) => this.#links.has(`${userId}\u0000${tradeId}\u0000${t.id}`));
  }

  async assign(userId: string, tradeId: string, tagId: string): Promise<boolean> {
    const key = `${userId}\u0000${tradeId}\u0000${tagId}`;
    if (this.#links.has(key)) return false;
    this.#links.add(key);
    return true;
  }

  async unassign(userId: string, tradeId: string, tagId: string): Promise<boolean> {
    return this.#links.delete(`${userId}\u0000${tradeId}\u0000${tagId}`);
  }

  async tradeOwnedBy(userId: string, tradeId: string): Promise<boolean> {
    return this.#trades.has(`${userId}\u0000${tradeId}`);
  }
}

export interface TagInput {
  readonly name: string;
  readonly kind: TagKind;
  readonly color: string | null;
}

/**
 * Validate tag input against the SAME rules as 0015's constraints.
 *
 * Returns the normalized input or throws a 400/409-shaped error. The service
 * never coerces an invalid value into a valid one (no trimming-to-empty, no
 * case-folding of duplicates).
 */
export function validateTagInput(body: Record<string, unknown>): TagInput {
  const rawName = body["name"];
  if (typeof rawName !== "string") throw new TagError(400, "VALIDATION_FAILED", "name is required.");
  const name = rawName.trim();
  if (name.length < 1 || name.length > 60) {
    throw new TagError(400, "VALIDATION_FAILED", "name must be between 1 and 60 characters.");
  }
  const rawKind = body["kind"];
  const kind = rawKind === undefined || rawKind === null ? "CUSTOM" : String(rawKind).toUpperCase();
  if (!TAG_KINDS.includes(kind as TagKind)) {
    throw new TagError(400, "VALIDATION_FAILED", `kind must be one of ${TAG_KINDS.join(", ")}.`);
  }
  const rawColor = body["color"];
  let color: string | null = null;
  if (rawColor !== undefined && rawColor !== null && rawColor !== "") {
    if (typeof rawColor !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(rawColor)) {
      throw new TagError(400, "VALIDATION_FAILED", "color must be #RRGGBB.");
    }
    color = rawColor;
  }
  return { name, kind: kind as TagKind, color };
}

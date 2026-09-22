// In-memory AccountStore adapter — development/test only (same boundary
// rules as MemoryUserStore; PERSISTENCE=memory is blocked outside development
// by the Phase B boot gate).
import {
  type AccountStore,
  type AccountRecord,
  type CreateAccountInput,
  AccountBindingConflictError,
} from "./accountStore.js";

const iso = (d: Date): string => d.toISOString();

export class MemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<string, AccountRecord>();
  private idCounter = 0;

  async listByUser(userId: string): Promise<AccountRecord[]> {
    return [...this.accounts.values()]
      .filter((a) => a.userId === userId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async findByIdForUser(id: string, userId: string): Promise<AccountRecord | null> {
    const a = this.accounts.get(id);
    return a !== undefined && a.userId === userId ? a : null;
  }

  async countByUser(userId: string): Promise<number> {
    let n = 0;
    for (const a of this.accounts.values()) if (a.userId === userId) n += 1;
    return n;
  }

  async create(
    userId: string,
    input: {
      provider: AccountRecord["provider"];
      platform: string;
      label: string;
      accountNumber: string;
      currency: string;
      leverage: string;
      timezone: string | null;
      timezoneSource: string;
      status: AccountRecord["status"];
    },
    now: Date,
  ): Promise<AccountRecord> {
    const i = input;
    const id = String(++this.idCounter);
    const record: AccountRecord = {
      id,
      userId,
      provider: i.provider,
      platform: i.platform,
      label: i.label,
      accountNumber: i.accountNumber,
      currency: i.currency,
      leverage: i.leverage,
      timezone: i.timezone,
      timezoneSource: i.timezoneSource,
      status: i.status,
      syncStatus: "DISCONNECTED",
      balance: "0.00",
      equity: "0.00",
      createdAt: iso(now),
      updatedAt: iso(now),
    };
    this.accounts.set(id, record);
    return record;
  }

  async updateTimezone(
    id: string,
    userId: string,
    timezone: string | null,
    timezoneSource: string,
    now: Date,
  ): Promise<AccountRecord | null> {
    const a = this.accounts.get(id);
    if (a === undefined || a.userId !== userId) return null;
    const updated: AccountRecord = { ...a, timezone, timezoneSource, updatedAt: iso(now) };
    this.accounts.set(id, updated);
    return updated;
  }

  async deleteForUser(id: string, userId: string): Promise<boolean> {
    const a = this.accounts.get(id);
    if (a === undefined || a.userId !== userId) return false;
    this.bindings.delete(id);
    return this.accounts.delete(id);
  }

  // --- OD-MP-1 / OD-MP-3 binding lifecycle -----------------------------------
  //
  // Held in a side map rather than on AccountRecord: the binding is NOT part of
  // the account's public API representation (OD-MP-1 rule 9 limits what is
  // persisted and exposed), and keeping it separate means no serializer can
  // leak it by accident.
  //
  // This adapter reproduces the DATABASE's semantics — global uniqueness and
  // compare-and-set — so a unit test exercises the same rules the real store
  // enforces. It CANNOT prove cross-process concurrency; only the real-PG
  // battery does that.
  private readonly bindings = new Map<string, string>();

  async bindMetaApiAccount(
    id: string,
    userId: string,
    binding: string,
    now: Date,
    expectUnbound: boolean,
  ): Promise<AccountRecord | null> {
    const a = this.accounts.get(id);
    if (a === undefined || a.userId !== userId) return null;

    // Global uniqueness, exactly as the partial UNIQUE index enforces it.
    for (const [otherId, value] of this.bindings) {
      if (value === binding && otherId !== id) throw new AccountBindingConflictError();
    }

    const current = this.bindings.get(id);
    if (current !== undefined) {
      if (expectUnbound) return null; // CAS loss: already bound
      if (current !== binding) return null; // never silently replace
    }

    this.bindings.set(id, binding);
    const updated: AccountRecord = { ...a, updatedAt: iso(now) };
    this.accounts.set(id, updated);
    return updated;
  }

  async unbindMetaApiAccount(id: string, userId: string, now: Date): Promise<string | null> {
    const a = this.accounts.get(id);
    if (a === undefined || a.userId !== userId) return null;
    const previous = this.bindings.get(id);
    if (previous === undefined) return null;
    this.bindings.delete(id);
    this.accounts.set(id, { ...a, updatedAt: iso(now) });
    return previous;
  }

  async getMetaApiBinding(id: string, userId: string): Promise<string | null> {
    const a = this.accounts.get(id);
    if (a === undefined || a.userId !== userId) return null;
    return this.bindings.get(id) ?? null;
  }
}

export type { CreateAccountInput };

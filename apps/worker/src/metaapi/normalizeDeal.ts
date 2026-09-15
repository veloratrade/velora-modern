// Provider deal → NormalizedFill. Pure: no I/O, no clock, no timezone database.
//
// This module is where D-5 (timestamps) and D-4 (PnL authority) become
// mechanical rather than a reviewer's responsibility.
//
// D-5 — THE TWO TIMESTAMP FIELDS ARE NEVER CONFLATED
//   `time`       offset-explicit (trailing Z or ±HH:MM) → parsed
//                deterministically to UTC → occurred_at_utc + rawTimeText,
//                time_status='resolved_utc'.
//   `brokerTime` NAIVE wall clock → preserved VERBATIM in brokerTimeText and
//                NOTHING ELSE. It never becomes an instant, never influences
//                occurred_at_utc, and never sets time_status='resolved_utc'.
//
//   Forbidden inference sources, exhaustive and binding (D-5 term 3): guessed
//   timezone, broker country, broker/server location, account location,
//   machine/host timezone, IANA inference, default application timezone, any
//   other heuristic. This file therefore contains NO timezone data, does NOT
//   call `new Date(naiveString)` (which would silently apply the host zone),
//   and does NOT read any environment value.
//
// D-4 — PROVIDER PROFIT IS AUTHORITATIVE
//   `profit` is carried through verbatim as a decimal string. It is never
//   recomputed, never adjusted, and never replaced by a locally derived value.
import type { MetaApiDeal, NormalizedFill } from "@velora/contracts";

/**
 * Offset-explicit iff the value ends with `Z` or a numeric ±HH:MM offset.
 * Identical rule to the legacy `MetaApiInstantResolver::OFFSET_PATTERN`, which
 * the Phase 2E verification proved is the one trustworthy MetaAPI time surface.
 */
const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:\d{2})$/i;

/**
 * Full date+time skeleton WITH an explicit designator. Requiring the whole
 * shape (not just the suffix) refuses partial/garbage values instead of
 * letting a lenient parser invent a date.
 */
const ABSOLUTE_INSTANT =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** Bounded, control-character-free provider text. */
function safeText(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t === "" || t.length > maxLen) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(t)) return null;
  return t;
}

/**
 * Resolve an offset-explicit provider timestamp to a UTC ISO string.
 *
 * Returns null for ANY value that is not a complete, offset-explicit instant —
 * including a naive `brokerTime`. Null means "no absolute instant is known",
 * never "assume UTC".
 */
export function resolveInstant(value: unknown): string | null {
  const raw = safeText(value, 64);
  if (raw === null) return null;
  // Gate BEFORE parsing: a naive value must never reach the parser, because
  // JS `Date` would interpret it in the host timezone.
  if (!OFFSET_SUFFIX.test(raw)) return null;
  if (!ABSOLUTE_INSTANT.test(raw)) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  // The offset is carried by the string itself, so the result is independent
  // of the host timezone.
  return new Date(ms).toISOString();
}

/** Decimal string, or null. Rejects floats-as-numbers (ADR-001: no IEEE-754). */
function decimalString(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return /^-?\d{1,20}(?:\.\d{1,8})?$/.test(t) ? t : null;
  }
  if (typeof value === "number") {
    // A JSON number is already float-parsed by the transport. Accept only
    // values that are exactly representable as integers-with-scale, and
    // stringify without exponent notation. Anything else is malformed.
    if (!Number.isFinite(value)) return null;
    const s = String(value);
    return /^-?\d{1,20}(?:\.\d{1,8})?$/.test(s) ? s : null;
  }
  return null;
}

/** MT5 entry types: DEAL_ENTRY_IN=0, DEAL_ENTRY_OUT=1 (INOUT/OUT_BY ignored). */
function entrySide(value: unknown): "in" | "out" | null {
  if (typeof value === "number") return value === 0 ? "in" : value === 1 ? "out" : null;
  const t = safeText(value, 32)?.toLowerCase();
  if (t === undefined || t === null) return null;
  if (t === "0" || t === "in" || t === "deal_entry_in" || t === "entry_in") return "in";
  if (t === "1" || t === "out" || t === "deal_entry_out" || t === "entry_out") return "out";
  return null;
}

function direction(value: unknown): "buy" | "sell" | null {
  const t = safeText(value, 50)?.toLowerCase();
  if (t === undefined || t === null) return null;
  if (t === "buy" || t === "deal_type_buy") return "buy";
  if (t === "sell" || t === "deal_type_sell") return "sell";
  return null;
}

/**
 * Normalize one provider deal.
 *
 * Returns null only when the deal has no usable identity — without a deal id
 * there is no idempotency anchor, so the row could not be deduplicated and
 * must not be stored. Every other imperfection is REPRESENTED rather than
 * dropped: an unresolved timestamp, a missing direction and a null price all
 * persist as evidence with the appropriate status, so the provider's actual
 * response stays auditable.
 */
export function normalizeDeal(deal: MetaApiDeal): NormalizedFill | null {
  const externalDealId =
    safeText(deal.id, 64) ?? safeText((deal as { dealId?: unknown }).dealId, 64) ?? null;
  if (externalDealId === null) return null;

  // TWO INDEPENDENT TIMESTAMP FIELDS — read separately, never cross-assigned.
  const rawTimeText = safeText(deal.time, 64);
  const occurredAtUtc = resolveInstant(deal.time);
  // Naive broker wall clock: preserved verbatim, never parsed (D-5 term 2).
  const brokerTimeText = safeText(deal.brokerTime, 64);

  return {
    externalDealId,
    positionId: safeText(deal.positionId, 64),
    entryType: entrySide(deal.entryType),
    direction: direction(deal.type),
    symbol: safeText(deal.symbol, 32),
    volume: decimalString(deal.volume),
    price: decimalString(deal.price),
    // D-4: carried through verbatim. Never recomputed.
    profit: decimalString(deal.profit),
    commission: decimalString(deal.commission),
    swap: decimalString(deal.swap),
    occurredAtUtc,
    // Mirrors resolution ONLY. A present brokerTimeText cannot make this
    // 'resolved_utc' — the DB CHECK sync_fills_time_consistency enforces the
    // same pairing independently.
    timeStatus: occurredAtUtc === null ? "unresolved" : "resolved_utc",
    rawTimeText,
    brokerTimeText,
  };
}

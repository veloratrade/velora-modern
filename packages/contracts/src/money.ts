// Money & precision contract — ADR-001 (Accepted, D-03).
// All financial values are STRINGS carrying fixed-scale decimals end-to-end
// (Postgres numeric arrives as string; NEVER through JS number / IEEE-754).
export const SCALES = {
  price: 8, // entry/exit/SL/TP  numeric(20,8)
  volume: 8, // numeric(20,8)
  contractSize: 8, // numeric(20,8)
  currency: 2, // commission/swap/net PnL numeric(20,2)
  rMultiple: 8, // numeric(20,8)
} as const;

export type ScaleKey = keyof typeof SCALES;

// Branded string types — the only legal representation of financial values.
export type DecimalString<S extends number = number> = string & { readonly __scale: S };
export type Price = DecimalString<typeof SCALES.price>;
export type Volume = DecimalString<typeof SCALES.volume>;
export type ContractSize = DecimalString<typeof SCALES.contractSize>;
export type CurrencyAmount = DecimalString<typeof SCALES.currency>;
export type RMultiple = DecimalString<typeof SCALES.rMultiple>;

export const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

export function isDecimalString(v: unknown): v is DecimalString {
  return typeof v === "string" && DECIMAL_STRING_RE.test(v);
}

// Rounding modes (ADR-001 §4): bcmath-equivalent truncation for historical
// parity recomputation; half-even for new currency computations.
export type RoundingMode = "bcmath-truncate" | "half-even";

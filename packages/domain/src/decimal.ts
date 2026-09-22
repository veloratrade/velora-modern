// First-party fixed-point decimal — ADR-001 (Accepted, D-03).
//
// RATIONALE (implementation decision, recorded in ADR-011):
//  - IEEE-754 is prohibited for financial math (ADR-001 §1).
//  - Postgres `numeric` crosses into Node as a STRING; this engine keeps
//    everything as (unscaled BigInt, scale) — mirrors bcmath's scale-pinned
//    string arithmetic that the verified PHP PnlCalculator used.
//  - Zero dependencies → auditable, no supply-chain surface for money math.
//
// Strings in, strings out. `fromNumber` intentionally throws.

export type RoundingMode = "bcmath-truncate" | "half-even";

export interface Fixed {
  /** signed unscaled value; numeric value = u / 10^s */
  readonly u: bigint;
  readonly s: number;
}

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export class DecimalError extends Error {}
export class ZeroDivisionError extends DecimalError {}
export class FloatForbiddenError extends DecimalError {
  constructor() {
    super("IEEE-754 numbers are forbidden for financial values (ADR-001)");
  }
}

const pow10 = (n: number): bigint => 10n ** BigInt(n);

export function fromString(str: string): Fixed {
  if (!DECIMAL_RE.test(str)) {
    throw new DecimalError(`invalid decimal string: ${JSON.stringify(str)}`);
  }
  const neg = str.startsWith("-");
  const body = neg ? str.slice(1) : str;
  const dot = body.indexOf(".");
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? "" : body.slice(dot + 1);
  const s = fracPart.length;
  const u = BigInt((neg ? "-" : "") + intPart.concat(fracPart));
  return { u, s };
}

export function fromNumber(_n: number): never {
  throw new FloatForbiddenError();
}

export function toString(f: Fixed): string {
  const neg = f.u < 0n;
  const absStr = (neg ? -f.u : f.u).toString().padStart(f.s + 1, "0");
  const intPart = f.s === 0 ? absStr : absStr.slice(0, absStr.length - f.s);
  const fracPart = f.s === 0 ? "" : "." + absStr.slice(absStr.length - f.s);
  return (neg ? "-" : "") + intPart + fracPart;
}

function align(a: Fixed, b: Fixed): { x: bigint; y: bigint; s: number } {
  const s = Math.max(a.s, b.s);
  return { x: a.u * pow10(s - a.s), y: b.u * pow10(s - b.s), s };
}

export const add = (a: Fixed, b: Fixed): Fixed => {
  const { x, y, s } = align(a, b);
  return { u: x + y, s };
};

export const sub = (a: Fixed, b: Fixed): Fixed => {
  const { x, y, s } = align(a, b);
  return { u: x - y, s };
};

export const mul = (a: Fixed, b: Fixed): Fixed => ({ u: a.u * b.u, s: a.s + b.s });

export function div(a: Fixed, b: Fixed, targetScale: number, mode: RoundingMode): Fixed {
  if (b.u === 0n) throw new ZeroDivisionError("division by zero");
  // value = (a.u / 10^a.s) / (b.u / 10^b.s) at scale targetScale:
  //   N = a.u * 10^(target + b.s);  D = b.u * 10^(a.s)   → N/D has scale target.
  const N = a.u * pow10(targetScale + b.s);
  const D = b.u * pow10(a.s);
  const neg = N < 0n !== D < 0n;
  const nAbs = N < 0n ? -N : N;
  const dAbs = D < 0n ? -D : D;
  let q = nAbs / dAbs;
  const r = nAbs % dAbs;
  if (mode === "half-even") {
    const twice = r * 2n;
    if (twice > dAbs || (twice === dAbs && q % 2n === 1n)) q += 1n;
  } // "bcmath-truncate": drop remainder (toward zero), matching PHP bcmath.
  return { u: neg ? -q : q, s: targetScale };
}

/** Rescale to `target`: extend exactly; reduce with the given rounding mode. */
export function rescale(f: Fixed, target: number, mode: RoundingMode): Fixed {
  if (target === f.s) return f;
  if (target > f.s) return { u: f.u * pow10(target - f.s), s: target };
  const dropPow = pow10(f.s - target);
  const neg = f.u < 0n;
  const abs = neg ? -f.u : f.u;
  let q = abs / dropPow;
  const r = abs % dropPow;
  if (mode === "half-even") {
    const twice = r * 2n;
    if (twice > dropPow || (twice === dropPow && q % 2n === 1n)) q += 1n;
  }
  return { u: neg ? -q : q, s: target };
}

export const cmp = (a: Fixed, b: Fixed): -1 | 0 | 1 => {
  const { x, y } = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
};
export const isZero = (f: Fixed): boolean => f.u === 0n;
export const isNeg = (f: Fixed): boolean => f.u < 0n;
export const abs = (f: Fixed): Fixed => ({ u: f.u < 0n ? -f.u : f.u, s: f.s });
export const negate = (f: Fixed): Fixed => ({ u: -f.u, s: f.s });
export const fromScaled = (u: bigint, s: number): Fixed => ({ u, s });

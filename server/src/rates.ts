// Currencies and conversion. Pure: no DB, no HTTP. Integer-only arithmetic.
//
// A rate is "how many units of the target currency one unit of the source buys", stored as an
// integer scaled by RATE_SCALE (1e9), never a float. Amounts are integer minor units
// (cents, yen, …) of their own currency; `decimals` says how many minor units make one major unit.
//
//   base_minor = orig_minor × rate × 10^(baseDecimals − origDecimals) / RATE_SCALE, rounded half-up
//
// BigInt keeps the intermediate product exact (orig ≤ 1e9 × rate ≤ ~1e13 overflows a double).
import { MoneyError, MAX_AMOUNT_CENTS } from "./money.js";

export const RATE_SCALE = 1_000_000_000n;
export const RATE_DECIMALS = 9;

export interface Currency {
  code: string;
  name: string;
  /** Minor units per major unit = 10^decimals. TWD/JPY/KRW are counted in whole units. */
  decimals: number;
  /** Seeded, approximate: USD per 1 unit, scaled by RATE_SCALE. A starting point, not a feed. */
  usdPerUnit: bigint;
}

const RATE_RE = /^\d+(\.\d{1,9})?$/;
const usd = (s: string): bigint => parseRate(s);

export const CURRENCIES: Currency[] = [
  { code: "USD", name: "US Dollar", decimals: 2, usdPerUnit: usd("1") },
  { code: "EUR", name: "Euro", decimals: 2, usdPerUnit: usd("1.08") },
  { code: "GBP", name: "British Pound", decimals: 2, usdPerUnit: usd("1.27") },
  { code: "JPY", name: "Japanese Yen", decimals: 0, usdPerUnit: usd("0.0067") },
  { code: "TWD", name: "New Taiwan Dollar", decimals: 0, usdPerUnit: usd("0.031") },
  { code: "CNY", name: "Chinese Yuan", decimals: 2, usdPerUnit: usd("0.138") },
  { code: "HKD", name: "Hong Kong Dollar", decimals: 2, usdPerUnit: usd("0.128") },
  { code: "KRW", name: "South Korean Won", decimals: 0, usdPerUnit: usd("0.00072") },
  { code: "SGD", name: "Singapore Dollar", decimals: 2, usdPerUnit: usd("0.74") },
  { code: "THB", name: "Thai Baht", decimals: 2, usdPerUnit: usd("0.028") },
  { code: "VND", name: "Vietnamese Dong", decimals: 0, usdPerUnit: usd("0.00004") },
  { code: "MYR", name: "Malaysian Ringgit", decimals: 2, usdPerUnit: usd("0.21") },
  { code: "PHP", name: "Philippine Peso", decimals: 2, usdPerUnit: usd("0.0175") },
  { code: "IDR", name: "Indonesian Rupiah", decimals: 0, usdPerUnit: usd("0.000063") },
  { code: "INR", name: "Indian Rupee", decimals: 2, usdPerUnit: usd("0.012") },
  { code: "AUD", name: "Australian Dollar", decimals: 2, usdPerUnit: usd("0.65") },
  { code: "CAD", name: "Canadian Dollar", decimals: 2, usdPerUnit: usd("0.73") },
  { code: "CHF", name: "Swiss Franc", decimals: 2, usdPerUnit: usd("1.12") },
  { code: "NZD", name: "New Zealand Dollar", decimals: 2, usdPerUnit: usd("0.60") },
  { code: "SEK", name: "Swedish Krona", decimals: 2, usdPerUnit: usd("0.095") },
];

const BY_CODE = new Map(CURRENCIES.map((c) => [c.code, c]));

export class CurrencyError extends Error {
  readonly status = 400;
  readonly code: "UNKNOWN_CURRENCY" | "INVALID_RATE";
  constructor(code: "UNKNOWN_CURRENCY" | "INVALID_RATE", message: string) {
    super(message);
    this.name = "CurrencyError";
    this.code = code;
  }
}

export function isCurrency(code: string): boolean {
  return BY_CODE.has(code);
}

export function currency(code: string): Currency {
  const c = BY_CODE.get(code);
  if (!c) throw new CurrencyError("UNKNOWN_CURRENCY", `unknown currency "${code}"`);
  return c;
}

/** "0.0312" → 31_200_000n (scaled by 1e9). Up to 9 decimals, > 0. String arithmetic only. */
export function parseRate(s: string): bigint {
  if (typeof s !== "string" || !RATE_RE.test(s)) {
    throw new CurrencyError("INVALID_RATE", `invalid rate "${s}"`);
  }
  const [whole, frac = ""] = s.split(".");
  const n = BigInt(whole ?? "0") * RATE_SCALE + BigInt(frac.padEnd(RATE_DECIMALS, "0"));
  if (n <= 0n) throw new CurrencyError("INVALID_RATE", "rate must be > 0");
  return n;
}

/** 31_200_000n → "0.0312" (trailing zeros trimmed, at least one decimal kept as "1.0"? no: "1"). */
export function formatRate(rate: bigint): string {
  const whole = rate / RATE_SCALE;
  const frac = (rate % RATE_SCALE).toString().padStart(RATE_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Round-half-up integer division for non-negative operands. */
function divHalfUp(num: bigint, den: bigint): bigint {
  return (2n * num + den) / (2n * den);
}

/**
 * Seeded cross rate from → to, derived through USD: usd[from] / usd[to], scaled by RATE_SCALE.
 * An identity pair returns exactly RATE_SCALE.
 */
export function seededRate(from: string, to: string): bigint {
  if (from === to) return RATE_SCALE;
  const f = currency(from);
  const t = currency(to);
  return divHalfUp(f.usdPerUnit * RATE_SCALE, t.usdPerUnit);
}

/**
 * Convert `amountMinor` of `from` into minor units of `to` at `rate` (to per from, scaled).
 * Half-up to the target's minor unit; the result must still fit MAX_AMOUNT_CENTS.
 */
export function convert(amountMinor: number, from: string, to: string, rate: bigint): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new MoneyError("INVALID_AMOUNT", `invalid amount ${amountMinor}`);
  }
  if (rate <= 0n) throw new CurrencyError("INVALID_RATE", "rate must be > 0");
  const f = currency(from);
  const t = currency(to);
  const shift = t.decimals - f.decimals;
  let num = BigInt(amountMinor) * rate;
  let den = RATE_SCALE;
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den *= 10n ** BigInt(-shift);
  const out = divHalfUp(num, den);
  if (out > BigInt(MAX_AMOUNT_CENTS)) {
    throw new MoneyError("AMOUNT_OUT_OF_RANGE", `converted amount exceeds the maximum`);
  }
  return Number(out);
}

// Display helpers and *preview-only* split arithmetic for the expense sheet.
// The server (server/src/money.ts) is the source of truth; after Save the UI renders
// what the server returns. These previews copy the same integer rules (floor + first-r /
// largest remainder) so what the user sees before saving matches what gets stored.

/** Code → minor-unit decimals. Mirrors server/src/rates.ts `CURRENCIES` (same order). */
export const CURRENCIES: { code: string; name: string; decimals: number }[] = [
  { code: "USD", name: "US Dollar", decimals: 2 },
  { code: "EUR", name: "Euro", decimals: 2 },
  { code: "GBP", name: "British Pound", decimals: 2 },
  { code: "JPY", name: "Japanese Yen", decimals: 0 },
  { code: "TWD", name: "New Taiwan Dollar", decimals: 0 },
  { code: "CNY", name: "Chinese Yuan", decimals: 2 },
  { code: "HKD", name: "Hong Kong Dollar", decimals: 2 },
  { code: "KRW", name: "South Korean Won", decimals: 0 },
  { code: "SGD", name: "Singapore Dollar", decimals: 2 },
  { code: "THB", name: "Thai Baht", decimals: 2 },
  { code: "VND", name: "Vietnamese Dong", decimals: 0 },
  { code: "MYR", name: "Malaysian Ringgit", decimals: 2 },
  { code: "PHP", name: "Philippine Peso", decimals: 2 },
  { code: "IDR", name: "Indonesian Rupiah", decimals: 0 },
  { code: "INR", name: "Indian Rupee", decimals: 2 },
  { code: "AUD", name: "Australian Dollar", decimals: 2 },
  { code: "CAD", name: "Canadian Dollar", decimals: 2 },
  { code: "CHF", name: "Swiss Franc", decimals: 2 },
  { code: "NZD", name: "New Zealand Dollar", decimals: 2 },
  { code: "SEK", name: "Swedish Krona", decimals: 2 },
];

export const CURRENCY_DECIMALS: Record<string, number> = Object.fromEntries(CURRENCIES.map((c) => [c.code, c.decimals]));

export const decimalsOf = (code: string): number => CURRENCY_DECIMALS[code] ?? 2;

// Only symbols that are unambiguous in this app's list; everything else gets "CODE ".
const SYMBOLS: Record<string, string> = { USD: "$", TWD: "NT$", JPY: "¥", EUR: "€", GBP: "£" };

/** Minor units → "NT$1,234" / "$12.34" / "THB 1,234.50"; negatives get U+2212. */
export function formatMoney(minor: number, currency: string, decimals = decimalsOf(currency)): string {
  const sign = minor < 0 ? "−" : "";
  const prefix = SYMBOLS[currency] ?? `${currency} `;
  return `${sign}${prefix}${formatNumber(Math.abs(minor), decimals)}`;
}

/** 123456, 2 → "1,234.56" (no symbol). */
export function formatNumber(absMinor: number, decimals: number): string {
  const unit = 10 ** decimals;
  const whole = Math.floor(absMinor / unit).toLocaleString("en-US");
  if (decimals === 0) return whole;
  return `${whole}.${(absMinor % unit).toString().padStart(decimals, "0")}`;
}

/** "+NT$12" / "−NT$12" / "NT$0" — for balance pills. */
export function formatSigned(minor: number, currency: string, decimals = decimalsOf(currency)): string {
  return minor > 0 ? `+${formatMoney(minor, currency, decimals)}` : formatMoney(minor, currency, decimals);
}

/** "12.34", 2 → 1234; 0 decimals accepts integers only. Anything the server would reject → null. */
export function parseMinor(input: string, decimals: number): number | null {
  const s = input.trim();
  const re = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  if (!re.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const n = Number(whole) * 10 ** decimals + Number(frac.padEnd(decimals, "0") || "0");
  return Number.isSafeInteger(n) ? n : null;
}

/** "33.33" → 3333 basis points (hundredths of a percent); invalid → null. */
export function parseBasisPoints(input: string): number | null {
  return parseMinor(input, 2); // same grammar: up to 2 decimals
}

/** Minor units → "12.34" / "648" (no symbol), for refilling inputs and API amount strings. */
export function minorToDecimal(minor: number, decimals: number): string {
  return decimals === 0 ? String(minor) : formatNumber(minor, decimals).replace(/,/g, "");
}

// ---- rates (decimal strings, ≤ 9 decimals; scaled ×1e9 as BigInt, like server/src/rates.ts) ----

const RATE_RE = /^\d+(\.\d{1,9})?$/;
const SCALE = 1_000_000_000n;

/** "0.216129032" → 216129032n; invalid or ≤ 0 → null. */
export function parseRate(s: string): bigint | null {
  const t = s.trim();
  if (!RATE_RE.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const n = BigInt(whole!) * SCALE + BigInt(frac.padEnd(9, "0"));
  return n > 0n ? n : null;
}

const divHalfUp = (num: bigint, den: bigint) => (2n * num + den) / (2n * den);

/**
 * Preview of the server's `convert`: minor × rate × 10^(toDec − fromDec), half-up.
 * `rate` is "to per 1 from". An optional `divRate` divides by a second rate, for cross rates
 * through the base (X → base at rateX, base → Y at 1/rateY). Invalid rate → null.
 */
export function convertPreview(
  minor: number,
  fromDecimals: number,
  toDecimals: number,
  rate: string,
  divRate?: string,
): number | null {
  const r = parseRate(rate);
  const d = divRate === undefined ? SCALE : parseRate(divRate);
  if (r === null || d === null || !Number.isSafeInteger(minor) || minor < 0) return null;
  const shift = toDecimals - fromDecimals;
  let num = BigInt(minor) * r;
  let den = d;
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den *= 10n ** BigInt(-shift);
  return Number(divHalfUp(num, den));
}

/** "0.216129032" → "0.2161"; display only (4 significant digits after leading zeros). */
export function shortRate(rate: string): string {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return rate;
  if (n >= 1000) return Math.round(n).toLocaleString("en-US");
  return String(Number(n.toPrecision(n >= 1 ? 6 : 4)));
}

export interface Share {
  memberId: string;
  cents: number;
}

/** floor(total/n) each; the remainder goes one cent each to the first r members. */
export function previewEqual(totalCents: number, memberIds: string[]): Share[] {
  const n = memberIds.length;
  if (n === 0) return [];
  const base = Math.floor(totalCents / n);
  const r = totalCents - base * n;
  return memberIds.map((memberId, i) => ({ memberId, cents: base + (i < r ? 1 : 0) }));
}

/**
 * floor(total * bp / 10000) each, residual by largest remainder (ties → member order),
 * cycling until shares sum to total (residual may exceed n or be negative within ±0.01%).
 */
export function previewPercent(totalCents: number, shares: { memberId: string; bp: number }[]): Share[] {
  if (shares.length === 0) return [];
  const rows = shares.map((s, i) => {
    const num = totalCents * s.bp;
    return { memberId: s.memberId, i, floor: Math.floor(num / 10000), rem: num % 10000 };
  });
  let residual = totalCents - rows.reduce((a, r) => a + r.floor, 0);
  const result = rows.map((r) => r.floor);
  if (residual > 0) {
    const order = [...rows].sort((a, b) => b.rem - a.rem || a.i - b.i);
    let k = 0;
    while (residual > 0) {
      result[order[k % order.length]!.i]! += 1;
      residual--;
      k++;
    }
  } else if (residual < 0) {
    const order = [...rows].sort((a, b) => a.rem - b.rem || a.i - b.i);
    let k = 0;
    while (residual < 0) {
      result[order[k % order.length]!.i]! -= 1;
      residual++;
      k++;
    }
  }
  return rows.map((r) => ({ memberId: r.memberId, cents: result[r.i]! }));
}

export const PERCENT_TOLERANCE_BP = 1; // ±0.01%

// Display helpers and *preview-only* split arithmetic for the expense sheet.
// The server (server/src/money.ts) is the source of truth; after Save the UI renders
// what the server returns. These previews copy the same integer rules (floor + first-r /
// largest remainder) so what the user sees before saving matches what gets stored.

const DECIMAL_RE = /^\d+(\.\d{1,2})?$/;

/** 1234 → "$12.34"; −1234 → "−$12.34" (U+2212 minus). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}$${dollars.toLocaleString("en-US")}.${rest.toString().padStart(2, "0")}`;
}

/** "+$12.34" / "−$12.34" / "$0.00" — for balance pills. */
export function formatSigned(cents: number): string {
  return cents > 0 ? `+${formatCents(cents)}` : formatCents(cents);
}

/** "12.34" → 1234; anything the server would reject → null. Never uses float math. */
export function parseCents(input: string): number | null {
  const s = input.trim();
  if (!DECIMAL_RE.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** "33.33" → 3333 basis points (hundredths of a percent); invalid → null. */
export function parseBasisPoints(input: string): number | null {
  return parseCents(input); // same grammar: up to 2 decimals
}

/** Cents → "12.34" (no symbol), for refilling inputs. */
export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
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

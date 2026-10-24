// Pure money logic. All amounts are integer cents. No DB, no HTTP.

export type MoneyErrorCode =
  | "INVALID_AMOUNT"
  | "AMOUNT_OUT_OF_RANGE"
  | "EMPTY_MEMBERS"
  | "DUPLICATE_MEMBER"
  | "INVALID_PERCENT"
  | "PERCENT_SUM_MISMATCH"
  | "EXACT_SUM_MISMATCH";

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;
  constructor(code: MoneyErrorCode, message: string) {
    super(message);
    this.name = "MoneyError";
    this.code = code;
  }
}

export const MAX_AMOUNT_CENTS = 1_000_000_000; // 10,000,000.00

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;

/** Parse "12.34" → 1234 using string arithmetic only (never float). */
function parseDecimalString(s: string, opts: { allowZero: boolean }): number {
  if (typeof s !== "string" || !AMOUNT_RE.test(s)) {
    throw new MoneyError("INVALID_AMOUNT", `invalid amount "${s}"`);
  }
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) {
    throw new MoneyError("AMOUNT_OUT_OF_RANGE", `amount "${s}" too large`);
  }
  if (cents === 0 && !opts.allowZero) {
    throw new MoneyError("INVALID_AMOUNT", "amount must be > 0");
  }
  if (cents > MAX_AMOUNT_CENTS) {
    throw new MoneyError("AMOUNT_OUT_OF_RANGE", `amount "${s}" exceeds 10,000,000.00`);
  }
  return cents;
}

/** Decimal string matching ^\d+(\.\d{1,2})?$, > 0, ≤ 10,000,000.00 → integer cents. */
export function parseAmount(s: string): number {
  return parseDecimalString(s, { allowZero: false });
}

export interface Split {
  memberId: string;
  shareCents: number;
}

export interface SplitWithInput extends Split {
  inputValue: string;
}

function assertNoDuplicates(ids: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new MoneyError("DUPLICATE_MEMBER", `duplicate member "${id}"`);
    seen.add(id);
  }
}

function assertNonEmpty(ids: string[]): void {
  if (ids.length === 0) throw new MoneyError("EMPTY_MEMBERS", "at least one member required");
}

/** floor(total/n) each; remainder goes 1 cent each to the first r members in order. */
export function splitEqual(totalCents: number, memberIds: string[]): Split[] {
  assertNonEmpty(memberIds);
  assertNoDuplicates(memberIds);
  const n = memberIds.length;
  const base = Math.floor(totalCents / n);
  const remainder = totalCents - base * n;
  return memberIds.map((memberId, i) => ({
    memberId,
    shareCents: base + (i < remainder ? 1 : 0),
  }));
}

/** "33.33" → 3333 basis points (hundredths of a percent). ≥ 0, ≤ 2 decimals. */
function parseBasisPoints(s: string): number {
  if (typeof s !== "string" || !AMOUNT_RE.test(s)) {
    throw new MoneyError("INVALID_PERCENT", `invalid percent "${s}"`);
  }
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/**
 * Largest-remainder split. Sum of percents must be 100 ± 0.01.
 * Computed in integer basis points: share = total * bp / 10000.
 */
export function splitPercent(
  totalCents: number,
  shares: { memberId: string; percent: string }[],
): SplitWithInput[] {
  assertNonEmpty(shares.map((s) => s.memberId));
  assertNoDuplicates(shares.map((s) => s.memberId));
  const bps = shares.map((s) => parseBasisPoints(s.percent));
  const sumBp = bps.reduce((a, b) => a + b, 0);
  if (Math.abs(sumBp - 10_000) > 1) {
    throw new MoneyError("PERCENT_SUM_MISMATCH", `percents sum to ${sumBp / 100}, expected 100`);
  }
  const DENOM = 10_000;
  const rows = shares.map((s, i) => {
    const bp = bps[i]!;
    const numerator = totalCents * bp;
    return {
      memberId: s.memberId,
      inputValue: s.percent,
      floor: Math.floor(numerator / DENOM),
      remainder: numerator % DENOM,
      index: i,
    };
  });
  // Residual = total − Σfloor. Under the ±0.01 tolerance it may exceed one cent per member
  // (33.33 × 3) or be negative (50 + 50.01), so cycle until Σ share = total exactly.
  const cents = rows.map((r) => r.floor);
  let residual = totalCents - cents.reduce((a, b) => a + b, 0);
  if (residual > 0) {
    // Largest remainder first; ties by input order.
    const order = [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
    for (let k = 0; residual > 0; k = (k + 1) % order.length) {
      cents[order[k]!.index]! += 1;
      residual -= 1;
    }
  } else if (residual < 0) {
    // Smallest remainder first; ties by input order. Never push a share below 0.
    const order = [...rows].sort((a, b) => a.remainder - b.remainder || a.index - b.index);
    // Σ cents = total − residual > total > 0, so at least one share is positive each cycle.
    for (let k = 0; residual < 0; k = (k + 1) % order.length) {
      const idx = order[k]!.index;
      if (cents[idx]! === 0) continue;
      cents[idx]! -= 1;
      residual += 1;
    }
  }
  return rows.map((r) => ({
    memberId: r.memberId,
    shareCents: cents[r.index]!,
    inputValue: r.inputValue,
  }));
}

/** Each amount parsed (0 allowed); sum must equal total exactly. */
export function splitExact(
  totalCents: number,
  shares: { memberId: string; amount: string }[],
): SplitWithInput[] {
  assertNonEmpty(shares.map((s) => s.memberId));
  assertNoDuplicates(shares.map((s) => s.memberId));
  const result = shares.map((s) => ({
    memberId: s.memberId,
    shareCents: parseDecimalString(s.amount, { allowZero: true }),
    inputValue: s.amount,
  }));
  const sum = result.reduce((a, r) => a + r.shareCents, 0);
  if (sum !== totalCents) {
    throw new MoneyError("EXACT_SUM_MISMATCH", `shares sum to ${sum}, expected ${totalCents}`);
  }
  return result;
}

export interface ExpenseLike {
  payerId: string;
  amountCents: number;
  splits: Split[];
}

export interface Balance {
  memberId: string;
  paidCents: number;
  owedCents: number;
  netCents: number;
}

/** A recorded payment from one member to another ("mark paid"). */
export interface SettlementLike {
  fromId: string;
  toId: string;
  amountCents: number;
}

/**
 * A settlement enters the books like an expense paid by `from` whose only split is `to`
 * (SPEC "Data model"): from +amount, to −amount. One conversion feeds both `balances` and
 * `settleDirect`, so the two never disagree on what a payment means.
 */
function settlementsAsExpenses(settlements: SettlementLike[]): ExpenseLike[] {
  return settlements.map((s) => ({
    payerId: s.fromId,
    amountCents: s.amountCents,
    splits: [{ memberId: s.toId, shareCents: s.amountCents }],
  }));
}

/**
 * paid − owed per member, in memberIds order. Members with no activity appear as zeros.
 * Settlements count as `from` paid and `to` owed, so paidCents/owedCents include them.
 */
export function balances(
  expenses: ExpenseLike[],
  memberIds: string[],
  settlements: SettlementLike[] = [],
): Balance[] {
  const paid = new Map<string, number>();
  const owed = new Map<string, number>();
  for (const id of memberIds) {
    paid.set(id, 0);
    owed.set(id, 0);
  }
  for (const e of [...expenses, ...settlementsAsExpenses(settlements)]) {
    paid.set(e.payerId, (paid.get(e.payerId) ?? 0) + e.amountCents);
    for (const s of e.splits) {
      owed.set(s.memberId, (owed.get(s.memberId) ?? 0) + s.shareCents);
    }
  }
  return memberIds.map((memberId) => {
    const p = paid.get(memberId) ?? 0;
    const o = owed.get(memberId) ?? 0;
    return { memberId, paidCents: p, owedCents: o, netCents: p - o };
  });
}

export interface Transfer {
  fromId: string;
  toId: string;
  cents: number;
}

/**
 * Two-pointer greedy: creditors (net > 0) desc, debtors (net < 0) by |net| desc,
 * each step transfers min(credit, debt). At most n − 1 transfers; not globally minimal.
 */
export function settle(bals: Pick<Balance, "memberId" | "netCents">[]): Transfer[] {
  const creditors = bals
    .filter((b) => b.netCents > 0)
    .map((b) => ({ id: b.memberId, left: b.netCents }))
    .sort((a, b) => b.left - a.left);
  const debtors = bals
    .filter((b) => b.netCents < 0)
    .map((b) => ({ id: b.memberId, left: -b.netCents }))
    .sort((a, b) => b.left - a.left);
  const out: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < creditors.length && j < debtors.length) {
    const c = creditors[i]!;
    const d = debtors[j]!;
    const cents = Math.min(c.left, d.left);
    out.push({ fromId: d.id, toId: c.id, cents });
    c.left -= cents;
    d.left -= cents;
    if (c.left === 0) i++;
    if (d.left === 0) j++;
  }
  return out;
}

/**
 * "Pay who paid for you": for every expense and every split whose member ≠ payer,
 * debt[member→payer] += share. Each unordered pair is netted (a→b − b→a) into one transfer
 * for the positive side. More transfers than `settle`, but every transfer goes to someone
 * who actually paid for you. Sorted by amount desc, ties by member order (from, then to).
 * A settlement from→to is a debt to→from of the same amount, i.e. it cancels from→to.
 */
export function settleDirect(
  expenses: ExpenseLike[],
  memberIds: string[],
  settlements: SettlementLike[] = [],
): Transfer[] {
  const order = new Map(memberIds.map((id, i) => [id, i]));
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  // Keyed by canonical pair "lo|hi" (member order); value = net owed from lo to hi (signed).
  const net = new Map<string, number>();
  for (const e of [...expenses, ...settlementsAsExpenses(settlements)]) {
    for (const s of e.splits) {
      if (s.memberId === e.payerId || s.shareCents === 0) continue;
      const loFirst = rank(s.memberId) <= rank(e.payerId);
      const [lo, hi] = loFirst ? [s.memberId, e.payerId] : [e.payerId, s.memberId];
      const key = `${lo}|${hi}`;
      net.set(key, (net.get(key) ?? 0) + (loFirst ? s.shareCents : -s.shareCents));
    }
  }
  const out: Transfer[] = [];
  for (const [key, cents] of net) {
    if (cents === 0) continue;
    const [lo, hi] = key.split("|") as [string, string];
    out.push(cents > 0 ? { fromId: lo, toId: hi, cents } : { fromId: hi, toId: lo, cents: -cents });
  }
  return out.sort(
    (a, b) => b.cents - a.cents || rank(a.fromId) - rank(b.fromId) || rank(a.toId) - rank(b.toId),
  );
}

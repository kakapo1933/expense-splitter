// Application logic: SQL + money.ts, no HTTP. Every write runs in one transaction.
import type { DatabaseSync } from "node:sqlite";
import { withTx } from "./db.js";
import { ConflictError, GroupNotEmptyError, NotFoundError, SameMemberError, UnknownMemberError } from "./errors.js";
import {
  MoneyError,
  balances,
  parseAmount,
  settle,
  settleDirect,
  splitEqual,
  splitExact,
  splitPercent,
  type Balance,
  type Transfer,
} from "./money.js";
import {
  CURRENCIES,
  CurrencyError,
  RATE_SCALE,
  convert,
  currency as currencyInfo,
  formatRate,
  parseRate,
  seededRate,
} from "./rates.js";
import type { ExpenseInput, SettlementInput } from "./schemas.js";

// ---- Public view types (what GET /api/groups/:id returns; see SPEC "API") ----

export interface GroupRow {
  id: string;
  name: string;
  currency: string;
  createdAt: string;
}
export interface MemberRow {
  id: string;
  name: string;
  createdAt: string;
  /** ISO timestamp when the member left the group; null = active. History is kept either way. */
  leftAt: string | null;
}
export interface SettlementView {
  id: string;
  fromId: string;
  toId: string;
  amountCents: number;
  createdAt: string;
}
export interface SplitRow {
  memberId: string;
  shareCents: number;
  /** percent or exact amount as typed; null for equal mode (nothing was typed). */
  inputValue: string | null;
}
export interface ExpenseView {
  id: string;
  description: string;
  /** In the group's base currency; what splits and balances use. */
  amountCents: number;
  /** Currency as paid, the amount in its minor units, and the locked rate (base per 1 unit). */
  currency: string;
  originalCents: number;
  rate: string;
  payerId: string;
  splitMode: "equal" | "exact" | "percent";
  createdAt: string;
  updatedAt: string;
  splits: SplitRow[];
}
export interface RateRow {
  currency: string;
  name: string;
  decimals: number;
  /** Base units per 1 unit of `currency`, decimal string. */
  rate: string;
  source: "seed" | "override";
}
export interface RatesView {
  base: string;
  table: RateRow[];
}
export interface GroupView {
  group: GroupRow;
  rates: RatesView;
  members: MemberRow[];
  expenses: ExpenseView[];
  /** Recorded payments, newest first. */
  settlements: SettlementView[];
  balances: Balance[];
  settlement: Transfer[];
  settlementDirect: Transfer[];
}

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { errcode?: number }).errcode === 2067; // SQLITE_CONSTRAINT_UNIQUE

export function createService(db: DatabaseSync) {
  const q = {
    insertGroup: db.prepare("INSERT INTO groups (id, name, currency, created_at) VALUES (?, ?, ?, ?)"),
    getGroup: db.prepare(
      "SELECT id, name, currency, created_at AS createdAt FROM groups WHERE id = ?",
    ),
    setGroupCurrency: db.prepare("UPDATE groups SET currency = ? WHERE id = ?"),
    countExpenses: db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE group_id = ?"),
    listRates: db.prepare("SELECT currency, rate_nanos AS rateNanos FROM group_rates WHERE group_id = ?"),
    getRate: db.prepare("SELECT rate_nanos AS rateNanos FROM group_rates WHERE group_id = ? AND currency = ?"),
    upsertRate: db.prepare(
      `INSERT INTO group_rates (group_id, currency, rate_nanos, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (group_id, currency) DO UPDATE SET rate_nanos = excluded.rate_nanos, updated_at = excluded.updated_at`,
    ),
    deleteRate: db.prepare("DELETE FROM group_rates WHERE group_id = ? AND currency = ?"),
    insertMember: db.prepare("INSERT INTO members (id, group_id, name, created_at) VALUES (?, ?, ?, ?)"),
    getMember: db.prepare(
      "SELECT id, name, created_at AS createdAt, left_at AS leftAt FROM members WHERE id = ? AND group_id = ?",
    ),
    setMemberLeft: db.prepare("UPDATE members SET left_at = ? WHERE id = ? AND group_id = ?"),
    // Member order = insertion order = SQLite rowid (SPEC "Money logic"). Never a timestamp:
    // two inserts in the same millisecond would tie and fall back to random UUID order.
    listMembers: db.prepare(
      "SELECT id, name, created_at AS createdAt, left_at AS leftAt FROM members WHERE group_id = ? ORDER BY rowid",
    ),
    insertSettlement: db.prepare(
      "INSERT INTO settlements (id, group_id, from_id, to_id, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    deleteSettlement: db.prepare("DELETE FROM settlements WHERE id = ? AND group_id = ?"),
    getSettlement: db.prepare(
      `SELECT id, from_id AS fromId, to_id AS toId, amount_cents AS amountCents, created_at AS createdAt
       FROM settlements WHERE id = ? AND group_id = ?`,
    ),
    listSettlements: db.prepare(
      `SELECT id, from_id AS fromId, to_id AS toId, amount_cents AS amountCents, created_at AS createdAt
       FROM settlements WHERE group_id = ? ORDER BY rowid DESC`,
    ),
    insertExpense: db.prepare(
      `INSERT INTO expenses (id, group_id, payer_id, description, amount_cents, split_mode, created_at, updated_at,
                             currency, original_cents, rate_nanos)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateExpense: db.prepare(
      `UPDATE expenses SET payer_id = ?, description = ?, amount_cents = ?, split_mode = ?, updated_at = ?,
                           currency = ?, original_cents = ?, rate_nanos = ?
       WHERE id = ? AND group_id = ?`,
    ),
    deleteExpense: db.prepare("DELETE FROM expenses WHERE id = ? AND group_id = ?"),
    deleteSplits: db.prepare("DELETE FROM expense_splits WHERE expense_id = ?"),
    insertSplit: db.prepare(
      "INSERT INTO expense_splits (expense_id, member_id, share_cents, input_value) VALUES (?, ?, ?, ?)",
    ),
    getExpense: db.prepare(
      `SELECT id, description, amount_cents AS amountCents, currency, original_cents AS originalCents,
              rate_nanos AS rateNanos, payer_id AS payerId, split_mode AS splitMode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM expenses WHERE id = ? AND group_id = ?`,
    ),
    // Newest first by insertion order (rowid), for the same reason as members.
    listExpenses: db.prepare(
      `SELECT id, description, amount_cents AS amountCents, currency, original_cents AS originalCents,
              rate_nanos AS rateNanos, payer_id AS payerId, split_mode AS splitMode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM expenses WHERE group_id = ? ORDER BY rowid DESC`,
    ),
    listSplitsForGroup: db.prepare(
      `SELECT s.expense_id AS expenseId, s.member_id AS memberId, s.share_cents AS shareCents, s.input_value AS inputValue
       FROM expense_splits s JOIN expenses e ON e.id = s.expense_id
       WHERE e.group_id = ?`,
    ),
    listSplits: db.prepare(
      "SELECT member_id AS memberId, share_cents AS shareCents, input_value AS inputValue FROM expense_splits WHERE expense_id = ?",
    ),
  };

  function requireGroup(groupId: string): GroupRow {
    const row = q.getGroup.get(groupId) as GroupRow | undefined;
    if (!row) throw new NotFoundError("group");
    return row;
  }

  type ExpenseDbRow = Omit<ExpenseView, "splits" | "rate"> & { rateNanos: number };
  const toExpenseView = ({ rateNanos, ...row }: ExpenseDbRow, splits: SplitRow[]): ExpenseView => ({
    ...row,
    rate: formatRate(BigInt(rateNanos)),
    splits,
  });

  function requireExpense(groupId: string, expenseId: string): ExpenseView {
    const row = q.getExpense.get(expenseId, groupId) as ExpenseDbRow | undefined;
    if (!row) throw new NotFoundError("expense");
    return toExpenseView(row, q.listSplits.all(expenseId) as unknown as SplitRow[]);
  }

  /** Group override for currency → base, if any. */
  function overrideRate(groupId: string, code: string): bigint | undefined {
    const row = q.getRate.get(groupId, code) as { rateNanos: number } | undefined;
    return row ? BigInt(row.rateNanos) : undefined;
  }

  function ratesView(group: GroupRow): RatesView {
    const overrides = new Map(
      (q.listRates.all(group.id) as unknown as { currency: string; rateNanos: number }[]).map((r) => [
        r.currency,
        BigInt(r.rateNanos),
      ]),
    );
    return {
      base: group.currency,
      table: CURRENCIES.filter((c) => c.code !== group.currency).map((c) => {
        const o = overrides.get(c.code);
        return {
          currency: c.code,
          name: c.name,
          decimals: c.decimals,
          rate: formatRate(o ?? seededRate(c.code, group.currency)),
          source: o === undefined ? ("seed" as const) : ("override" as const),
        };
      }),
    };
  }

  /**
   * Resolve the expense's currency and locked rate: explicit `rate` → group override →
   * seeded cross rate. A base-currency expense is always at exactly RATE_SCALE; supplying a
   * rate for it is rejected rather than silently ignored.
   */
  function resolveRate(group: GroupRow, input: ExpenseInput): { code: string; rate: bigint } {
    const code = input.currency ?? group.currency;
    currencyInfo(code); // UNKNOWN_CURRENCY
    if (code === group.currency) {
      if (input.rate !== undefined) {
        throw new CurrencyError("INVALID_RATE", "a base-currency expense cannot carry a rate");
      }
      return { code, rate: RATE_SCALE };
    }
    if (input.rate !== undefined) return { code, rate: parseRate(input.rate) };
    return { code, rate: overrideRate(group.id, code) ?? seededRate(code, group.currency) };
  }

  /**
   * Validate membership and compute shares. Splits are re-ordered into member order
   * before calling money.ts so remainder cents land on the earliest-joined members
   * regardless of how the client ordered the request.
   */
  function computeSplits(
    group: GroupRow,
    input: ExpenseInput,
  ): { amountCents: number; currency: string; originalCents: number; rate: bigint; splits: SplitRow[] } {
    const groupId = group.id;
    const members = q.listMembers.all(groupId) as unknown as MemberRow[];
    const order = new Map(members.map((m, i) => [m.id, i]));
    const requested =
      input.split.mode === "equal" ? input.split.memberIds : input.split.shares.map((s) => s.memberId);
    const unknown = [input.payerId, ...requested].filter((id) => !order.has(id));
    if (unknown.length) throw new UnknownMemberError([...new Set(unknown)]);

    const byMemberOrder = <T extends { memberId: string }>(xs: T[]) =>
      [...xs].sort((a, b) => order.get(a.memberId)! - order.get(b.memberId)!);

    const { code, rate } = resolveRate(group, input);
    const base = group.currency;
    const originalCents = parseAmount(input.amount, currencyInfo(code).decimals);
    const amountCents = convert(originalCents, code, base, rate);
    if (amountCents <= 0) {
      throw new MoneyError("INVALID_AMOUNT", "amount converts to zero in the base currency");
    }
    const meta = { amountCents, currency: code, originalCents, rate };
    switch (input.split.mode) {
      case "equal": {
        const ids = byMemberOrder(input.split.memberIds.map((memberId) => ({ memberId }))).map(
          (x) => x.memberId,
        );
        return { ...meta, splits: splitEqual(amountCents, ids).map((s) => ({ ...s, inputValue: null })) };
      }
      case "exact": {
        // Shares are typed in the ORIGINAL currency and must sum to the original amount there
        // (splitExact checks). Each share is then converted to base at the same rate. Rounding
        // each share independently can leave Σ base shares ≠ amountCents by a few minor units;
        // that residual goes to the member(s) whose exact converted value was cut the most
        // (largest remainder, ties → member order), so Σ share_cents === amount_cents exactly.
        const orig = splitExact(originalCents, byMemberOrder(input.split.shares), currencyInfo(code).decimals);
        return { ...meta, splits: convertShares(orig, code, base, rate, amountCents) };
      }
      case "percent":
        return { ...meta, splits: splitPercent(amountCents, byMemberOrder(input.split.shares)) };
    }
  }

  /** See the "exact" case above. Floors each converted share, then hands out the residual. */
  function convertShares(
    shares: SplitRow[],
    from: string,
    to: string,
    rate: bigint,
    totalBase: number,
  ): SplitRow[] {
    const shift = currencyInfo(to).decimals - currencyInfo(from).decimals;
    const den = shift >= 0 ? RATE_SCALE : RATE_SCALE * 10n ** BigInt(-shift);
    const mul = shift >= 0 ? 10n ** BigInt(shift) : 1n;
    const exact = shares.map((s) => {
      const num = BigInt(s.shareCents) * rate * mul;
      return { floor: num / den, rem: num % den };
    });
    const out = shares.map((s, i) => ({ ...s, shareCents: Number(exact[i]!.floor) }));
    let residual = totalBase - out.reduce((n, s) => n + s.shareCents, 0);
    // Σ floor ≤ floor(Σ exact) ≤ round(Σ exact) = totalBase, and the gap is < shares.length + 1,
    // so residual is a small non-negative count. Order: largest remainder first, stable on index.
    const order = exact.map((e, i) => ({ i, rem: e.rem })).sort((a, b) => (a.rem === b.rem ? a.i - b.i : a.rem > b.rem ? -1 : 1));
    for (let k = 0; residual > 0; k = (k + 1) % order.length, residual--) {
      out[order[k]!.i]!.shareCents += 1;
    }
    return out;
  }

  function writeSplits(expenseId: string, splits: SplitRow[]) {
    for (const s of splits) q.insertSplit.run(expenseId, s.memberId, s.shareCents, s.inputValue);
  }

  return {
    createGroup(name: string, currency = "USD"): GroupRow {
      currencyInfo(currency); // UNKNOWN_CURRENCY
      const id = uuid();
      q.insertGroup.run(id, name, currency, now());
      return requireGroup(id);
    },

    /** Base currency change; only while the group has no expenses (their rates are locked to the base). */
    setGroupCurrency(groupId: string, currency: string): GroupRow {
      requireGroup(groupId);
      currencyInfo(currency);
      return withTx(db, () => {
        const { n } = q.countExpenses.get(groupId) as { n: number };
        if (n > 0) throw new GroupNotEmptyError();
        q.setGroupCurrency.run(currency, groupId);
        // Overrides are relative to the old base; the new base's own row would be meaningless.
        q.deleteRate.run(groupId, currency);
        return requireGroup(groupId);
      });
    },

    /** Upsert the group's override for currency → base. Returns the rates block. */
    setRate(groupId: string, currency: string, rate: string): RatesView {
      const group = requireGroup(groupId);
      currencyInfo(currency);
      if (currency === group.currency) {
        throw new CurrencyError("INVALID_RATE", "the base currency's rate is fixed at 1");
      }
      const nanos = parseRate(rate);
      q.upsertRate.run(groupId, currency, nanos, now());
      return ratesView(group);
    },

    deleteRate(groupId: string, currency: string): void {
      requireGroup(groupId);
      const { changes } = q.deleteRate.run(groupId, currency);
      if (changes === 0) throw new NotFoundError("rate override");
    },

    addMember(groupId: string, name: string): MemberRow {
      requireGroup(groupId);
      const id = uuid();
      try {
        q.insertMember.run(id, groupId, name, now());
      } catch (e) {
        if (isUniqueViolation(e)) throw new ConflictError(`member "${name}" already exists in this group`);
        throw e;
      }
      return q.getMember.get(id, groupId) as unknown as MemberRow;
    },

    /** Leaving is a flag, not a delete: the member stays in balances and in the plan. Reversible. */
    setMemberLeft(groupId: string, memberId: string, left: boolean): MemberRow {
      requireGroup(groupId);
      const { changes } = q.setMemberLeft.run(left ? now() : null, memberId, groupId);
      if (changes === 0) throw new NotFoundError("member");
      return q.getMember.get(memberId, groupId) as unknown as MemberRow;
    },

    /** "Mark paid": records a payment from → to. Enters balances like an expense paid by `from` split to `to`. */
    createSettlement(groupId: string, input: SettlementInput): SettlementView {
      const group = requireGroup(groupId);
      if (input.fromId === input.toId) throw new SameMemberError();
      return withTx(db, () => {
        const members = q.listMembers.all(groupId) as unknown as MemberRow[];
        const known = new Set(members.map((m) => m.id));
        const unknown = [input.fromId, input.toId].filter((id) => !known.has(id));
        if (unknown.length) throw new UnknownMemberError(unknown);
        const amountCents = parseAmount(input.amount, currencyInfo(group.currency).decimals);
        const id = uuid();
        q.insertSettlement.run(id, groupId, input.fromId, input.toId, amountCents, now());
        return q.getSettlement.get(id, groupId) as unknown as SettlementView;
      });
    },

    deleteSettlement(groupId: string, settlementId: string): void {
      requireGroup(groupId);
      const { changes } = q.deleteSettlement.run(settlementId, groupId);
      if (changes === 0) throw new NotFoundError("settlement");
    },

    createExpense(groupId: string, input: ExpenseInput): ExpenseView {
      const group = requireGroup(groupId);
      return withTx(db, () => {
        const { amountCents, currency, originalCents, rate, splits } = computeSplits(group, input);
        const id = uuid();
        const ts = now();
        q.insertExpense.run(
          id, groupId, input.payerId, input.description, amountCents, input.split.mode, ts, ts,
          currency, originalCents, rate,
        );
        writeSplits(id, splits);
        return requireExpense(groupId, id);
      });
    },

    /** Edit = update the expense row, drop its old splits, insert the new ones — one transaction. */
    updateExpense(groupId: string, expenseId: string, input: ExpenseInput): ExpenseView {
      const group = requireGroup(groupId);
      return withTx(db, () => {
        requireExpense(groupId, expenseId);
        const { amountCents, currency, originalCents, rate, splits } = computeSplits(group, input);
        q.updateExpense.run(
          input.payerId, input.description, amountCents, input.split.mode, now(),
          currency, originalCents, rate, expenseId, groupId,
        );
        q.deleteSplits.run(expenseId);
        writeSplits(expenseId, splits);
        return requireExpense(groupId, expenseId);
      });
    },

    /** Hard delete; splits go with it via ON DELETE CASCADE. */
    deleteExpense(groupId: string, expenseId: string): void {
      requireGroup(groupId);
      const { changes } = q.deleteExpense.run(expenseId, groupId);
      if (changes === 0) throw new NotFoundError("expense");
    },

    getGroupView(groupId: string): GroupView {
      const group = requireGroup(groupId);
      const members = q.listMembers.all(groupId) as unknown as MemberRow[];
      const expenseRows = q.listExpenses.all(groupId) as unknown as ExpenseDbRow[];
      const splitRows = q.listSplitsForGroup.all(groupId) as unknown as (SplitRow & { expenseId: string })[];
      const byExpense = new Map<string, SplitRow[]>();
      for (const { expenseId, ...s } of splitRows) {
        (byExpense.get(expenseId) ?? byExpense.set(expenseId, []).get(expenseId)!).push(s);
      }
      const expenses = expenseRows.map((e) => toExpenseView(e, byExpense.get(e.id) ?? []));
      const settlements = q.listSettlements.all(groupId) as unknown as SettlementView[];
      const memberIds = members.map((m) => m.id);
      const bals = balances(expenses, memberIds, settlements);
      return {
        group,
        rates: ratesView(group),
        members,
        expenses,
        settlements,
        balances: bals,
        settlement: settle(bals),
        settlementDirect: settleDirect(expenses, memberIds, settlements),
      };
    },
  };
}

export type Service = ReturnType<typeof createService>;

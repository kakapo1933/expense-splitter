// Application logic: SQL + money.ts, no HTTP. Every write runs in one transaction.
import type { DatabaseSync } from "node:sqlite";
import { withTx } from "./db.js";
import { ConflictError, NotFoundError, SameMemberError, UnknownMemberError } from "./errors.js";
import {
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
  amountCents: number;
  payerId: string;
  splitMode: "equal" | "exact" | "percent";
  createdAt: string;
  updatedAt: string;
  splits: SplitRow[];
}
export interface GroupView {
  group: GroupRow;
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
    insertGroup: db.prepare("INSERT INTO groups (id, name, currency, created_at) VALUES (?, ?, 'USD', ?)"),
    getGroup: db.prepare(
      "SELECT id, name, currency, created_at AS createdAt FROM groups WHERE id = ?",
    ),
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
      `INSERT INTO expenses (id, group_id, payer_id, description, amount_cents, split_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateExpense: db.prepare(
      `UPDATE expenses SET payer_id = ?, description = ?, amount_cents = ?, split_mode = ?, updated_at = ?
       WHERE id = ? AND group_id = ?`,
    ),
    deleteExpense: db.prepare("DELETE FROM expenses WHERE id = ? AND group_id = ?"),
    deleteSplits: db.prepare("DELETE FROM expense_splits WHERE expense_id = ?"),
    insertSplit: db.prepare(
      "INSERT INTO expense_splits (expense_id, member_id, share_cents, input_value) VALUES (?, ?, ?, ?)",
    ),
    getExpense: db.prepare(
      `SELECT id, description, amount_cents AS amountCents, payer_id AS payerId, split_mode AS splitMode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM expenses WHERE id = ? AND group_id = ?`,
    ),
    // Newest first by insertion order (rowid), for the same reason as members.
    listExpenses: db.prepare(
      `SELECT id, description, amount_cents AS amountCents, payer_id AS payerId, split_mode AS splitMode,
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

  function requireExpense(groupId: string, expenseId: string): ExpenseView {
    const row = q.getExpense.get(expenseId, groupId) as Omit<ExpenseView, "splits"> | undefined;
    if (!row) throw new NotFoundError("expense");
    return { ...row, splits: q.listSplits.all(expenseId) as unknown as SplitRow[] };
  }

  /**
   * Validate membership and compute shares. Splits are re-ordered into member order
   * before calling money.ts so remainder cents land on the earliest-joined members
   * regardless of how the client ordered the request.
   */
  function computeSplits(
    groupId: string,
    input: ExpenseInput,
  ): { amountCents: number; splits: SplitRow[] } {
    const members = q.listMembers.all(groupId) as unknown as MemberRow[];
    const order = new Map(members.map((m, i) => [m.id, i]));
    const requested =
      input.split.mode === "equal" ? input.split.memberIds : input.split.shares.map((s) => s.memberId);
    const unknown = [input.payerId, ...requested].filter((id) => !order.has(id));
    if (unknown.length) throw new UnknownMemberError([...new Set(unknown)]);

    const byMemberOrder = <T extends { memberId: string }>(xs: T[]) =>
      [...xs].sort((a, b) => order.get(a.memberId)! - order.get(b.memberId)!);

    const amountCents = parseAmount(input.amount);
    switch (input.split.mode) {
      case "equal": {
        const ids = byMemberOrder(input.split.memberIds.map((memberId) => ({ memberId }))).map(
          (x) => x.memberId,
        );
        return {
          amountCents,
          splits: splitEqual(amountCents, ids).map((s) => ({ ...s, inputValue: null })),
        };
      }
      case "exact":
        return { amountCents, splits: splitExact(amountCents, byMemberOrder(input.split.shares)) };
      case "percent":
        return { amountCents, splits: splitPercent(amountCents, byMemberOrder(input.split.shares)) };
    }
  }

  function writeSplits(expenseId: string, splits: SplitRow[]) {
    for (const s of splits) q.insertSplit.run(expenseId, s.memberId, s.shareCents, s.inputValue);
  }

  return {
    createGroup(name: string): GroupRow {
      const id = uuid();
      q.insertGroup.run(id, name, now());
      return requireGroup(id);
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
      requireGroup(groupId);
      if (input.fromId === input.toId) throw new SameMemberError();
      return withTx(db, () => {
        const members = q.listMembers.all(groupId) as unknown as MemberRow[];
        const known = new Set(members.map((m) => m.id));
        const unknown = [input.fromId, input.toId].filter((id) => !known.has(id));
        if (unknown.length) throw new UnknownMemberError(unknown);
        const amountCents = parseAmount(input.amount);
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
      requireGroup(groupId);
      return withTx(db, () => {
        const { amountCents, splits } = computeSplits(groupId, input);
        const id = uuid();
        const ts = now();
        q.insertExpense.run(id, groupId, input.payerId, input.description, amountCents, input.split.mode, ts, ts);
        writeSplits(id, splits);
        return requireExpense(groupId, id);
      });
    },

    /** Edit = update the expense row, drop its old splits, insert the new ones — one transaction. */
    updateExpense(groupId: string, expenseId: string, input: ExpenseInput): ExpenseView {
      requireGroup(groupId);
      return withTx(db, () => {
        requireExpense(groupId, expenseId);
        const { amountCents, splits } = computeSplits(groupId, input);
        q.updateExpense.run(input.payerId, input.description, amountCents, input.split.mode, now(), expenseId, groupId);
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
      const expenseRows = q.listExpenses.all(groupId) as unknown as Omit<ExpenseView, "splits">[];
      const splitRows = q.listSplitsForGroup.all(groupId) as unknown as (SplitRow & { expenseId: string })[];
      const byExpense = new Map<string, SplitRow[]>();
      for (const { expenseId, ...s } of splitRows) {
        (byExpense.get(expenseId) ?? byExpense.set(expenseId, []).get(expenseId)!).push(s);
      }
      const expenses = expenseRows.map((e) => ({ ...e, splits: byExpense.get(e.id) ?? [] }));
      const settlements = q.listSettlements.all(groupId) as unknown as SettlementView[];
      const memberIds = members.map((m) => m.id);
      const bals = balances(expenses, memberIds, settlements);
      return {
        group,
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

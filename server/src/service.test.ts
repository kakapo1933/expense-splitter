import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openDb } from "./db.js";
import { ConflictError, GroupNotEmptyError, NotFoundError, SameMemberError, UnknownMemberError } from "./errors.js";
import { MoneyError } from "./money.js";
import { CurrencyError } from "./rates.js";
import { createService } from "./service.js";

const fresh = () => createService(openDb(":memory:"));

describe("service: full lifecycle on an in-memory DB", () => {
  it("create → members → equal → exact → delete, balances follow", () => {
    const svc = fresh();
    const g = svc.createGroup("Trip");
    const a = svc.addMember(g.id, "Ann");
    const b = svc.addMember(g.id, "Bob");
    const c = svc.addMember(g.id, "Cy");
    const ids = [a.id, b.id, c.id];

    // member order = insertion order (rowid), deterministic even within one millisecond
    let view = svc.getGroupView(g.id);
    assert.deepEqual(view.members.map((m) => m.id), ids);
    assert.deepEqual(view.expenses, []);
    assert.ok(view.balances.every((x) => x.netCents === 0));

    const e = svc.createExpense(g.id, {
      description: "Dinner",
      amount: "100.00",
      payerId: a.id,
      split: { mode: "equal", memberIds: [c.id, b.id, a.id] },
    });
    assert.equal(e.amountCents, 10000);
    assert.equal(e.splitMode, "equal");
    assert.equal(e.splits.length, 3);
    assert.ok(e.splits.every((s) => s.inputValue === null));
    assert.equal(e.splits.reduce((n, s) => n + s.shareCents, 0), 10000);
    // the extra cent lands on Ann, who joined first (regardless of request order)
    const share = (id: string) => e.splits.find((s) => s.memberId === id)!.shareCents;
    assert.deepEqual([share(a.id), share(b.id), share(c.id)], [3334, 3333, 3333]);

    view = svc.getGroupView(g.id);
    const net = (id: string) => view.balances.find((x) => x.memberId === id)!.netCents;
    assert.equal(view.balances.reduce((n, x) => n + x.netCents, 0), 0);
    assert.equal(net(a.id), 6666); // paid 10000, owes 3334
    assert.equal(net(b.id), -3333);
    assert.equal(net(c.id), -3333);
    assert.equal(view.settlement.length, 2);
    assert.ok(view.settlement.every((t) => t.toId === a.id));
    // direct mode is present and zeroes every balance too
    assert.equal(view.settlementDirect.length, 2);
    const after = new Map(view.balances.map((x) => [x.memberId, x.netCents]));
    for (const t of view.settlementDirect) {
      after.set(t.fromId, after.get(t.fromId)! + t.cents);
      after.set(t.toId, after.get(t.toId)! - t.cents);
    }
    assert.ok([...after.values()].every((n) => n === 0));

    // edit → exact, with input values round-tripped
    const e2 = svc.updateExpense(g.id, e.id, {
      description: "Dinner (fixed)",
      amount: "100.00",
      payerId: a.id,
      split: {
        mode: "exact",
        shares: [
          { memberId: a.id, amount: "0" },
          { memberId: b.id, amount: "60.00" },
          { memberId: c.id, amount: "40" },
        ],
      },
    });
    assert.equal(e2.id, e.id);
    assert.equal(e2.description, "Dinner (fixed)");
    assert.equal(e2.splits.find((s) => s.memberId === b.id)!.inputValue, "60.00");
    view = svc.getGroupView(g.id);
    assert.equal(view.expenses.length, 1);
    assert.equal(view.expenses[0]!.splits.length, 3); // old splits gone, not accumulated
    assert.equal(net(a.id), 10000);
    assert.equal(net(b.id), -6000);
    assert.equal(net(c.id), -4000);

    svc.deleteExpense(g.id, e.id);
    view = svc.getGroupView(g.id);
    assert.deepEqual(view.expenses, []);
    assert.ok(view.balances.every((x) => x.netCents === 0 && x.paidCents === 0 && x.owedCents === 0));
    assert.deepEqual(view.settlement, []);
    assert.deepEqual(view.settlementDirect, []);
  });

  it("percent split stores the typed percent and sums to the total", () => {
    const svc = fresh();
    const g = svc.createGroup("P");
    const a = svc.addMember(g.id, "A");
    const b = svc.addMember(g.id, "B");
    const e = svc.createExpense(g.id, {
      description: "x",
      amount: "10.01",
      payerId: a.id,
      split: { mode: "percent", shares: [{ memberId: a.id, percent: "50" }, { memberId: b.id, percent: "50" }] },
    });
    assert.equal(e.splits.reduce((n, s) => n + s.shareCents, 0), 1001);
    assert.deepEqual(e.splits.map((s) => s.inputValue), ["50", "50"]);
  });

  it("expenses list newest first", () => {
    const svc = fresh();
    const g = svc.createGroup("N");
    const a = svc.addMember(g.id, "A");
    const mk = (d: string) =>
      svc.createExpense(g.id, { description: d, amount: "1", payerId: a.id, split: { mode: "equal", memberIds: [a.id] } });
    mk("one");
    const second = mk("two");
    const view = svc.getGroupView(g.id);
    assert.deepEqual(view.expenses.map((e) => e.description), ["two", "one"]);
    assert.equal(view.expenses[0]!.id, second.id);
  });
});

describe("service: rejections", () => {
  it("payer outside the group → UnknownMemberError (400)", () => {
    const svc = fresh();
    const g = svc.createGroup("G");
    const a = svc.addMember(g.id, "A");
    const other = svc.createGroup("Other");
    const stranger = svc.addMember(other.id, "S");
    assert.throws(
      () =>
        svc.createExpense(g.id, {
          description: "x",
          amount: "1",
          payerId: stranger.id,
          split: { mode: "equal", memberIds: [a.id] },
        }),
      (err: unknown) => err instanceof UnknownMemberError && err.code === "UNKNOWN_MEMBER",
    );
    // split member outside the group too
    assert.throws(
      () =>
        svc.createExpense(g.id, {
          description: "x",
          amount: "1",
          payerId: a.id,
          split: { mode: "equal", memberIds: [a.id, stranger.id] },
        }),
      UnknownMemberError,
    );
    assert.deepEqual(svc.getGroupView(g.id).expenses, []); // rolled back, nothing written
  });

  it("money errors propagate and leave no partial rows", () => {
    const svc = fresh();
    const g = svc.createGroup("G");
    const a = svc.addMember(g.id, "A");
    const b = svc.addMember(g.id, "B");
    assert.throws(
      () =>
        svc.createExpense(g.id, {
          description: "x",
          amount: "10",
          payerId: a.id,
          split: { mode: "percent", shares: [{ memberId: a.id, percent: "50" }, { memberId: b.id, percent: "40" }] },
        }),
      (err: unknown) => err instanceof MoneyError && err.code === "PERCENT_SUM_MISMATCH",
    );
    assert.deepEqual(svc.getGroupView(g.id).expenses, []);
  });

  it("duplicate member name → ConflictError; unknown group / expense → NotFoundError", () => {
    const svc = fresh();
    const g = svc.createGroup("G");
    svc.addMember(g.id, "Ann");
    assert.throws(() => svc.addMember(g.id, "Ann"), ConflictError);
    assert.equal(svc.getGroupView(g.id).members.length, 1);
    assert.throws(() => svc.getGroupView("nope"), NotFoundError);
    assert.throws(() => svc.addMember("nope", "x"), NotFoundError);
    assert.throws(() => svc.deleteExpense(g.id, "nope"), NotFoundError);
  });
});

describe("service: settlements (mark paid)", () => {
  const setup = () => {
    const svc = fresh();
    const g = svc.createGroup("S");
    const a = svc.addMember(g.id, "A");
    const b = svc.addMember(g.id, "B");
    svc.createExpense(g.id, {
      description: "Dinner",
      amount: "100",
      payerId: a.id,
      split: { mode: "equal", memberIds: [a.id, b.id] },
    });
    return { svc, g, a, b };
  };
  const net = (svc: ReturnType<typeof fresh>, gid: string, id: string) =>
    svc.getGroupView(gid).balances.find((x) => x.memberId === id)!.netCents;

  it("recording a payment moves balances and shrinks both plans; deleting it restores them", () => {
    const { svc, g, a, b } = setup();
    assert.deepEqual(svc.getGroupView(g.id).settlement, [{ fromId: b.id, toId: a.id, cents: 5000 }]);

    const s1 = svc.createSettlement(g.id, { fromId: b.id, toId: a.id, amount: "30" });
    assert.equal(s1.amountCents, 3000);
    let view = svc.getGroupView(g.id);
    assert.deepEqual(view.settlements.map((s) => s.id), [s1.id]);
    assert.equal(net(svc, g.id, a.id), 2000);
    assert.equal(net(svc, g.id, b.id), -2000);
    assert.deepEqual(view.settlement, [{ fromId: b.id, toId: a.id, cents: 2000 }]);
    assert.deepEqual(view.settlementDirect, [{ fromId: b.id, toId: a.id, cents: 2000 }]);
    // paid/owed include the payment (net = paid − owed holds)
    const bb = view.balances.find((x) => x.memberId === b.id)!;
    assert.deepEqual(bb, { memberId: b.id, paidCents: 3000, owedCents: 5000, netCents: -2000 });

    const s2 = svc.createSettlement(g.id, { fromId: b.id, toId: a.id, amount: "20.00" });
    view = svc.getGroupView(g.id);
    assert.deepEqual(view.settlements.map((s) => s.id), [s2.id, s1.id]); // newest first
    assert.ok(view.balances.every((x) => x.netCents === 0));
    assert.deepEqual(view.settlement, []);
    assert.deepEqual(view.settlementDirect, []);

    svc.deleteSettlement(g.id, s2.id);
    svc.deleteSettlement(g.id, s1.id);
    view = svc.getGroupView(g.id);
    assert.deepEqual(view.settlements, []);
    assert.deepEqual(view.settlement, [{ fromId: b.id, toId: a.id, cents: 5000 }]);
    assert.throws(() => svc.deleteSettlement(g.id, s1.id), NotFoundError);
  });

  it("rejects same member (400 SAME_MEMBER), strangers, bad amounts; unknown group 404", () => {
    const { svc, g, a, b } = setup();
    assert.throws(
      () => svc.createSettlement(g.id, { fromId: a.id, toId: a.id, amount: "1" }),
      (e: unknown) => e instanceof SameMemberError && e.code === "SAME_MEMBER",
    );
    const other = svc.createGroup("O");
    const stranger = svc.addMember(other.id, "X");
    assert.throws(() => svc.createSettlement(g.id, { fromId: stranger.id, toId: a.id, amount: "1" }), UnknownMemberError);
    assert.throws(
      () => svc.createSettlement(g.id, { fromId: b.id, toId: a.id, amount: "0" }),
      (e: unknown) => e instanceof MoneyError && e.code === "INVALID_AMOUNT",
    );
    assert.throws(() => svc.createSettlement("nope", { fromId: b.id, toId: a.id, amount: "1" }), NotFoundError);
    assert.deepEqual(svc.getGroupView(g.id).settlements, []);
  });
});

describe("service: members leaving", () => {
  it("left sets leftAt, member stays in balances and plan; clearing restores null", () => {
    const svc = fresh();
    const g = svc.createGroup("L");
    const a = svc.addMember(g.id, "A");
    const b = svc.addMember(g.id, "B");
    assert.equal(a.leftAt, null);
    svc.createExpense(g.id, { description: "x", amount: "10", payerId: a.id, split: { mode: "equal", memberIds: [a.id, b.id] } });

    const left = svc.setMemberLeft(g.id, b.id, true);
    assert.equal(typeof left.leftAt, "string");
    let view = svc.getGroupView(g.id);
    assert.deepEqual(view.members.map((m) => [m.id, m.leftAt !== null]), [[a.id, false], [b.id, true]]);
    assert.equal(view.balances.find((x) => x.memberId === b.id)!.netCents, -500);
    assert.deepEqual(view.settlement, [{ fromId: b.id, toId: a.id, cents: 500 }]);

    const back = svc.setMemberLeft(g.id, b.id, false);
    assert.equal(back.leftAt, null);
    view = svc.getGroupView(g.id);
    assert.ok(view.members.every((m) => m.leftAt === null));

    assert.throws(() => svc.setMemberLeft(g.id, "nope", true), NotFoundError);
    assert.throws(() => svc.setMemberLeft("nope", b.id, true), NotFoundError);
    // a member of another group is not reachable through this group
    const other = svc.createGroup("O");
    const x = svc.addMember(other.id, "X");
    assert.throws(() => svc.setMemberLeft(g.id, x.id, true), NotFoundError);
  });
});

describe("service: multi-currency", () => {
  const setup = (base?: string) => {
    const svc = fresh();
    const g = svc.createGroup("Trip", base);
    const ids = ["Ann", "Bob", "Cy"].map((n) => svc.addMember(g.id, n).id);
    return { svc, g, ids };
  };
  const equal = (ids: string[], extra: object) => ({
    description: "x",
    payerId: ids[0]!,
    split: { mode: "equal" as const, memberIds: ids },
    ...extra,
  });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return "no error";
  };

  it("TWD expense on a USD group converts at the seeded rate and splits in USD", () => {
    const { svc, g, ids } = setup();
    assert.equal(g.currency, "USD");
    const e = svc.createExpense(g.id, equal(ids, { amount: "1200", currency: "TWD" }));
    assert.equal(e.currency, "TWD");
    assert.equal(e.originalCents, 1200);
    assert.equal(e.rate, "0.031");
    assert.equal(e.amountCents, 3720);
    assert.deepEqual(e.splits.map((s) => s.shareCents), [1240, 1240, 1240]);
    const view = svc.getGroupView(g.id);
    assert.equal(view.balances.reduce((n, b) => n + b.netCents, 0), 0);
    assert.equal(view.expenses[0]!.rate, "0.031");
  });

  it("base-currency expense: rate 1, and a supplied rate is rejected", () => {
    const { svc, g, ids } = setup();
    const e = svc.createExpense(g.id, equal(ids, { amount: "10.00" }));
    assert.deepEqual([e.currency, e.originalCents, e.rate, e.amountCents], ["USD", 1000, "1", 1000]);
    assert.equal(code(() => svc.createExpense(g.id, equal(ids, { amount: "10", rate: "1.1" }))), "INVALID_RATE");
    assert.equal(
      code(() => svc.createExpense(g.id, equal(ids, { amount: "10", currency: "USD", rate: "1" }))),
      "INVALID_RATE",
    );
  });

  it("amount decimals follow the expense currency (TWD 0, base TWD settlements 0)", () => {
    const { svc, g, ids } = setup();
    assert.equal(code(() => svc.createExpense(g.id, equal(ids, { amount: "12.5", currency: "TWD" }))), "INVALID_AMOUNT");
    assert.equal(code(() => svc.createExpense(g.id, equal(ids, { amount: "1.234" }))), "INVALID_AMOUNT");
    const t = setup("TWD");
    assert.equal(t.g.currency, "TWD");
    const e = t.svc.createExpense(t.g.id, equal(t.ids, { amount: "300" }));
    assert.equal(e.amountCents, 300); // whole dollars, not 30000
    const st = t.svc.createSettlement(t.g.id, { fromId: t.ids[1]!, toId: t.ids[0]!, amount: "100" });
    assert.equal(st.amountCents, 100);
    assert.equal(code(() => t.svc.createSettlement(t.g.id, { fromId: t.ids[1]!, toId: t.ids[0]!, amount: "1.5" })), "INVALID_AMOUNT");
  });

  it("unknown currency → UNKNOWN_CURRENCY (400) on group, expense, rate", () => {
    const { svc, g, ids } = setup();
    assert.throws(() => svc.createGroup("X", "XYZ"), (e: unknown) => e instanceof CurrencyError && e.status === 400 && e.code === "UNKNOWN_CURRENCY");
    assert.equal(code(() => svc.createExpense(g.id, equal(ids, { amount: "1", currency: "XYZ" }))), "UNKNOWN_CURRENCY");
    assert.equal(code(() => svc.setRate(g.id, "XYZ", "1")), "UNKNOWN_CURRENCY");
    assert.equal(code(() => svc.setGroupCurrency(g.id, "XYZ")), "UNKNOWN_CURRENCY");
  });

  it("override changes the default for new expenses, not existing ones; delete restores seed", () => {
    const { svc, g, ids } = setup();
    const old = svc.createExpense(g.id, equal(ids, { amount: "1000", currency: "TWD" }));
    assert.equal(old.amountCents, 3100);
    const rates = svc.setRate(g.id, "TWD", "0.032");
    const twd = rates.table.find((r) => r.currency === "TWD")!;
    assert.deepEqual([twd.rate, twd.source, twd.decimals], ["0.032", "override", 0]);
    assert.equal(rates.base, "USD");
    assert.ok(!rates.table.some((r) => r.currency === "USD"));
    assert.equal(rates.table.length, 19);

    const neu = svc.createExpense(g.id, equal(ids, { amount: "1000", currency: "TWD" }));
    assert.deepEqual([neu.rate, neu.amountCents], ["0.032", 3200]);
    const view = svc.getGroupView(g.id);
    const oldNow = view.expenses.find((e) => e.id === old.id)!;
    assert.deepEqual([oldNow.rate, oldNow.amountCents], ["0.031", 3100]);

    // explicit rate beats the override
    const exp = svc.createExpense(g.id, equal(ids, { amount: "1000", currency: "TWD", rate: "0.03" }));
    assert.equal(exp.amountCents, 3000);

    svc.deleteRate(g.id, "TWD");
    assert.equal(svc.getGroupView(g.id).rates.table.find((r) => r.currency === "TWD")!.source, "seed");
    assert.throws(() => svc.deleteRate(g.id, "TWD"), NotFoundError);
    assert.equal(code(() => svc.setRate(g.id, "USD", "1")), "INVALID_RATE");
    assert.equal(code(() => svc.setRate(g.id, "TWD", "0")), "INVALID_RATE");
  });

  it("edit with a new rate re-converts and re-splits", () => {
    const { svc, g, ids } = setup();
    const e = svc.createExpense(g.id, equal(ids, { amount: "1200", currency: "TWD" }));
    const e2 = svc.updateExpense(g.id, e.id, equal(ids, { amount: "1200", currency: "TWD", rate: "0.03" }));
    assert.deepEqual([e2.rate, e2.amountCents], ["0.03", 3600]);
    assert.deepEqual(e2.splits.map((s) => s.shareCents), [1200, 1200, 1200]);
    // switching back to base on edit resets the rate to 1
    const e3 = svc.updateExpense(g.id, e.id, equal(ids, { amount: "36.00" }));
    assert.deepEqual([e3.currency, e3.rate, e3.originalCents, e3.amountCents], ["USD", "1", 3600, 3600]);
  });

  it("exact shares typed in the original currency sum to amount_cents exactly", () => {
    const { svc, g, ids } = setup();
    // 100 TWD @ 0.031 = 310¢. Shares 33/33/34 TWD → 102.3/102.3/105.4¢ → floors 102+102+105 = 309;
    // the residual cent goes to the largest remainder (Cy, .4).
    const e = svc.createExpense(g.id, {
      description: "x",
      amount: "100",
      currency: "TWD",
      payerId: ids[0]!,
      split: {
        mode: "exact",
        shares: [
          { memberId: ids[0]!, amount: "33" },
          { memberId: ids[1]!, amount: "33" },
          { memberId: ids[2]!, amount: "34" },
        ],
      },
    });
    assert.equal(e.amountCents, 310);
    const by = (id: string) => e.splits.find((s) => s.memberId === id)!;
    assert.deepEqual(ids.map((id) => [by(id).shareCents, by(id).inputValue]), [[102, "33"], [102, "33"], [106, "34"]]);
    assert.equal(e.splits.reduce((n, s) => n + s.shareCents, 0), e.amountCents);
    // shares must sum in the original currency
    assert.equal(
      code(() =>
        svc.createExpense(g.id, {
          description: "x",
          amount: "100",
          currency: "TWD",
          payerId: ids[0]!,
          split: { mode: "exact", shares: [{ memberId: ids[0]!, amount: "3.10" }] },
        }),
      ),
      "INVALID_AMOUNT",
    );
  });

  it("exact shares: residual stays exact across many awkward rates (property)", () => {
    const { svc, g, ids } = setup();
    for (let i = 1; i <= 50; i++) {
      const a = 7 * i + 3, b = 11 * i + 1, c = 13 * i;
      const e = svc.createExpense(g.id, {
        description: "p",
        amount: String(a + b + c),
        currency: "JPY",
        rate: `0.00${i}7`,
        payerId: ids[0]!,
        split: {
          mode: "exact",
          shares: [
            { memberId: ids[0]!, amount: String(a) },
            { memberId: ids[1]!, amount: String(b) },
            { memberId: ids[2]!, amount: String(c) },
          ],
        },
      });
      assert.equal(e.splits.reduce((n, s) => n + s.shareCents, 0), e.amountCents, `i=${i}`);
    }
  });

  it("base change allowed while empty, GROUP_NOT_EMPTY (409) once an expense exists", () => {
    const { svc, g, ids } = setup();
    svc.setRate(g.id, "EUR", "1.1");
    const changed = svc.setGroupCurrency(g.id, "EUR");
    assert.equal(changed.currency, "EUR");
    const view = svc.getGroupView(g.id);
    assert.equal(view.rates.base, "EUR");
    assert.ok(!view.rates.table.some((r) => r.currency === "EUR"));
    svc.createExpense(g.id, equal(ids, { amount: "5" }));
    assert.throws(() => svc.setGroupCurrency(g.id, "USD"), (e: unknown) => e instanceof GroupNotEmptyError && e.status === 409);
  });

  it("old-schema DB: columns added and backfilled as paid in base at rate 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "es-mig-"));
    const path = join(dir, "old.db");
    try {
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', created_at TEXT NOT NULL);
        CREATE TABLE members (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (group_id, name));
        CREATE TABLE expenses (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, payer_id TEXT NOT NULL, description TEXT NOT NULL,
          amount_cents INTEGER NOT NULL, split_mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE expense_splits (expense_id TEXT NOT NULL, member_id TEXT NOT NULL, share_cents INTEGER NOT NULL, input_value TEXT,
          PRIMARY KEY (expense_id, member_id));
        INSERT INTO groups VALUES ('g1', 'Old', 'EUR', '2025-01-01');
        INSERT INTO members VALUES ('m1', 'g1', 'Ann', '2025-01-01');
        INSERT INTO members VALUES ('m2', 'g1', 'Bob', '2025-01-01');
        INSERT INTO expenses VALUES ('e1', 'g1', 'm1', 'Dinner', 4200, 'equal', '2025-01-01', '2025-01-01');
        INSERT INTO expense_splits VALUES ('e1', 'm1', 2100, NULL), ('e1', 'm2', 2100, NULL);
      `);
      old.close();

      const db = openDb(path);
      const row = db.prepare("SELECT currency, original_cents AS o, rate_nanos AS r FROM expenses WHERE id = 'e1'").get();
      assert.deepEqual({ ...row }, { currency: "EUR", o: 4200, r: 1_000_000_000 });
      const view = createService(db).getGroupView("g1");
      const e = view.expenses[0]!;
      assert.deepEqual([e.currency, e.originalCents, e.rate, e.amountCents], ["EUR", 4200, "1", 4200]);
      assert.deepEqual(view.balances.map((b) => b.netCents), [2100, -2100]);
      assert.equal(view.rates.base, "EUR");
      db.close();
      openDb(path).close(); // idempotent second open
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

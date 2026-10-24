import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDb } from "./db.js";
import { ConflictError, NotFoundError, SameMemberError, UnknownMemberError } from "./errors.js";
import { MoneyError } from "./money.js";
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

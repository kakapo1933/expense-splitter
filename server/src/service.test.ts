import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openDb } from "./db.js";
import { ConflictError, NotFoundError, UnknownMemberError } from "./errors.js";
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

    // member order is created_at, id — three inserts in the same ms may reorder, so compare as sets
    let view = svc.getGroupView(g.id);
    assert.deepEqual(new Set(view.members.map((m) => m.id)), new Set(ids));
    assert.deepEqual(view.expenses, []);
    assert.ok(view.balances.every((x) => x.netCents === 0));

    const e = svc.createExpense(g.id, {
      description: "Dinner",
      amount: "100.00",
      payerId: a.id,
      split: { mode: "equal", memberIds: ids },
    });
    assert.equal(e.amountCents, 10000);
    assert.equal(e.splitMode, "equal");
    assert.equal(e.splits.length, 3);
    assert.ok(e.splits.every((s) => s.inputValue === null));
    assert.equal(e.splits.reduce((n, s) => n + s.shareCents, 0), 10000);
    // the extra cent lands on the first member in member order
    const first = svc.getGroupView(g.id).members[0]!.id;
    assert.equal(e.splits.find((s) => s.memberId === first)!.shareCents, 3334);

    view = svc.getGroupView(g.id);
    const net = (id: string) => view.balances.find((x) => x.memberId === id)!.netCents;
    assert.equal(view.balances.reduce((n, x) => n + x.netCents, 0), 0);
    if (first === a.id) {
      assert.equal(net(a.id), 6666);
      assert.equal(net(b.id), -3333);
      assert.equal(net(c.id), -3333);
    } else {
      // Ann paid 10000 and owes 3333; whoever is first owes 3334
      assert.equal(net(a.id), 6667);
      assert.deepEqual([net(b.id), net(c.id)].sort(), [-3334, -3333]);
    }
    assert.equal(view.settlement.length, 2);
    assert.ok(view.settlement.every((t) => t.toId === a.id));

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
    // same-ms tie breaks by id desc; just assert both present and the list is sorted by createdAt desc
    assert.equal(view.expenses.length, 2);
    assert.ok(view.expenses[0]!.createdAt >= view.expenses[1]!.createdAt);
    assert.ok(view.expenses.some((e) => e.id === second.id));
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

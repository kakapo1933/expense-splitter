import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  MoneyError,
  parseAmount,
  splitEqual,
  splitPercent,
  splitExact,
  balances,
  settle,
  settleDirect,
} from "./money.ts";

const sum = (xs: { shareCents: number }[]) => xs.reduce((a, x) => a + x.shareCents, 0);
const throwsMoney = (fn: () => unknown, code?: string) =>
  assert.throws(fn, (e: unknown) => e instanceof MoneyError && (code === undefined || e.code === code));

describe("parseAmount", () => {
  test("parses valid decimal strings to cents", () => {
    assert.equal(parseAmount("100"), 10000);
    assert.equal(parseAmount("0.01"), 1);
    assert.equal(parseAmount("12.3"), 1230);
    assert.equal(parseAmount("12.34"), 1234);
    assert.equal(parseAmount("10000000.00"), 1_000_000_000);
  });
  test("rejects invalid, zero, negative, empty, and out-of-range", () => {
    for (const s of ["12.345", "abc", "-1", "0", "", "0.00", "1e3", " 1", "1.", ".5"]) {
      throwsMoney(() => parseAmount(s));
    }
    throwsMoney(() => parseAmount("10000000.01"), "AMOUNT_OUT_OF_RANGE");
  });
  test("does not use float arithmetic (0.1 + 0.2 class)", () => {
    assert.equal(parseAmount("0.29"), 29);
    assert.equal(parseAmount("1.15"), 115);
  });
});

describe("splitEqual", () => {
  test("$100 / 3 → 3334/3333/3333", () => {
    const r = splitEqual(10000, ["a", "b", "c"]);
    assert.deepEqual(r.map((x) => x.shareCents), [3334, 3333, 3333]);
    assert.equal(sum(r), 10000);
  });
  test("$0.01 / 3 → 1/0/0", () => {
    assert.deepEqual(splitEqual(1, ["a", "b", "c"]).map((x) => x.shareCents), [1, 0, 0]);
  });
  test("one member takes all", () => {
    assert.deepEqual(splitEqual(999, ["a"]), [{ memberId: "a", shareCents: 999 }]);
  });
  test("empty members throws", () => throwsMoney(() => splitEqual(100, []), "EMPTY_MEMBERS"));
});

describe("splitPercent", () => {
  test("1000 by 33.33/33.33/33.34 sums to 1000, each 333–334", () => {
    const r = splitPercent(1000, [
      { memberId: "a", percent: "33.33" },
      { memberId: "b", percent: "33.33" },
      { memberId: "c", percent: "33.34" },
    ]);
    assert.equal(sum(r), 1000);
    for (const x of r) assert.ok(x.shareCents >= 333 && x.shareCents <= 334);
    assert.deepEqual(r.map((x) => x.inputValue), ["33.33", "33.33", "33.34"]);
  });
  test("100 by 50/50 → 50/50", () => {
    const r = splitPercent(100, [
      { memberId: "a", percent: "50" },
      { memberId: "b", percent: "50" },
    ]);
    assert.deepEqual(r.map((x) => x.shareCents), [50, 50]);
  });
  test("largest remainder, ties by input order", () => {
    // 100 cents by 1/3 each → floors 33,33,33, leftover 1 → first member gets it
    const r = splitPercent(100, [
      { memberId: "a", percent: "33.33" },
      { memberId: "b", percent: "33.33" },
      { memberId: "c", percent: "33.34" },
    ]);
    // remainders: a=3300, b=3300, c=3400 → c gets the extra cent
    assert.deepEqual(r.map((x) => x.shareCents), [33, 33, 34]);
    // true tie: 1 cent by 50/50 → remainders equal → first member gets it
    const tie = splitPercent(1, [{ memberId: "a", percent: "50" }, { memberId: "b", percent: "50" }]);
    assert.deepEqual(tie.map((x) => x.shareCents), [1, 0]);
  });
  test("sum 99.99 and 100.01 accepted; 90 rejected", () => {
    assert.equal(sum(splitPercent(1000, [{ memberId: "a", percent: "49.99" }, { memberId: "b", percent: "50" }])), 1000);
    assert.equal(sum(splitPercent(1000, [{ memberId: "a", percent: "50.01" }, { memberId: "b", percent: "50" }])), 1000);
    throwsMoney(
      () => splitPercent(1000, [{ memberId: "a", percent: "50.02" }, { memberId: "b", percent: "50" }]),
      "PERCENT_SUM_MISMATCH",
    );
    throwsMoney(
      () => splitPercent(1000, [{ memberId: "a", percent: "45" }, { memberId: "b", percent: "45" }]),
      "PERCENT_SUM_MISMATCH",
    );
  });
  test("positive residual beyond one cent per member: $1000 at 33.33 × 3", () => {
    const r = splitPercent(100000, [
      { memberId: "a", percent: "33.33" },
      { memberId: "b", percent: "33.33" },
      { memberId: "c", percent: "33.33" },
    ]);
    assert.equal(sum(r), 100000);
    const cents = r.map((x) => x.shareCents);
    assert.ok(Math.max(...cents) - Math.min(...cents) <= 1);
    assert.deepEqual(cents, [33334, 33333, 33333]);
  });
  test("negative residual: $1000 at 50 / 50.01 sums to total", () => {
    const r = splitPercent(100000, [
      { memberId: "a", percent: "50" },
      { memberId: "b", percent: "50.01" },
    ]);
    assert.equal(sum(r), 100000);
    // floors are 50000 / 50010 (residual −10); both remainders are 0 so the cut alternates.
    assert.deepEqual(r.map((x) => x.shareCents), [49995, 50005]);
    for (const x of r) assert.ok(x.shareCents >= 49990 && x.shareCents <= 50010);
  });
  test("negative residual never pushes a 0% share below zero", () => {
    const r = splitPercent(100000, [
      { memberId: "a", percent: "0" },
      { memberId: "b", percent: "0.01" },
      { memberId: "c", percent: "99.99" },
    ]);
    assert.equal(sum(r), 100000);
    assert.equal(r[0]!.shareCents, 0);
    for (const x of r) assert.ok(x.shareCents >= 0);
  });
  test("rejects bad percent strings", () => {
    throwsMoney(() => splitPercent(100, [{ memberId: "a", percent: "33.333" }, { memberId: "b", percent: "66.667" }]), "INVALID_PERCENT");
    throwsMoney(() => splitPercent(100, [{ memberId: "a", percent: "-10" }, { memberId: "b", percent: "110" }]), "INVALID_PERCENT");
  });
  test("zero percent allowed", () => {
    const r = splitPercent(100, [{ memberId: "a", percent: "0" }, { memberId: "b", percent: "100" }]);
    assert.deepEqual(r.map((x) => x.shareCents), [0, 100]);
  });
});

describe("splitExact", () => {
  test("matching sum passes, keeps inputValue, allows 0", () => {
    const r = splitExact(1000, [
      { memberId: "a", amount: "6" },
      { memberId: "b", amount: "4.00" },
      { memberId: "c", amount: "0" },
    ]);
    assert.deepEqual(r, [
      { memberId: "a", shareCents: 600, inputValue: "6" },
      { memberId: "b", shareCents: 400, inputValue: "4.00" },
      { memberId: "c", shareCents: 0, inputValue: "0" },
    ]);
  });
  test("off by one cent throws", () => {
    throwsMoney(() => splitExact(1000, [{ memberId: "a", amount: "6" }, { memberId: "b", amount: "3.99" }]), "EXACT_SUM_MISMATCH");
    throwsMoney(() => splitExact(1000, [{ memberId: "a", amount: "6" }, { memberId: "b", amount: "4.01" }]), "EXACT_SUM_MISMATCH");
  });
});

describe("duplicate memberId", () => {
  test("all split functions reject duplicates", () => {
    throwsMoney(() => splitEqual(100, ["a", "a"]), "DUPLICATE_MEMBER");
    throwsMoney(() => splitPercent(100, [{ memberId: "a", percent: "50" }, { memberId: "a", percent: "50" }]), "DUPLICATE_MEMBER");
    throwsMoney(() => splitExact(100, [{ memberId: "a", amount: "0.5" }, { memberId: "a", amount: "0.5" }]), "DUPLICATE_MEMBER");
  });
});

describe("balances", () => {
  const members = ["A", "B", "C"];
  test("A pays 10000 split 3 ways", () => {
    const b = balances([{ payerId: "A", amountCents: 10000, splits: splitEqual(10000, members) }], members);
    assert.deepEqual(b, [
      { memberId: "A", paidCents: 10000, owedCents: 3334, netCents: 6666 },
      { memberId: "B", paidCents: 0, owedCents: 3333, netCents: -3333 },
      { memberId: "C", paidCents: 0, owedCents: 3333, netCents: -3333 },
    ]);
    assert.equal(b.reduce((a, x) => a + x.netCents, 0), 0);
  });
  test("non-participating member appears as zeros", () => {
    const b = balances([{ payerId: "A", amountCents: 100, splits: splitEqual(100, ["A", "B"]) }], ["A", "B", "D"]);
    assert.deepEqual(b[2], { memberId: "D", paidCents: 0, owedCents: 0, netCents: 0 });
  });
  test("editing an expense (replacing splits) recomputes correctly", () => {
    const original = { payerId: "A", amountCents: 10000, splits: splitEqual(10000, members) };
    const edited = { payerId: "B", amountCents: 6000, splits: splitEqual(6000, ["A", "B"]) };
    const b = balances([edited], members);
    assert.deepEqual(b, [
      { memberId: "A", paidCents: 0, owedCents: 3000, netCents: -3000 },
      { memberId: "B", paidCents: 6000, owedCents: 3000, netCents: 3000 },
      { memberId: "C", paidCents: 0, owedCents: 0, netCents: 0 },
    ]);
    assert.notDeepEqual(balances([original], members), b);
  });
});

describe("settle", () => {
  test("three-way: two transfers, from debtors to creditor, everyone zeroed", () => {
    const members = ["A", "B", "C"];
    const b = balances([{ payerId: "A", amountCents: 10000, splits: splitEqual(10000, members) }], members);
    const t = settle(b);
    assert.equal(t.length, 2);
    const net = new Map(b.map((x) => [x.memberId, x.netCents]));
    for (const x of t) {
      assert.ok(net.get(x.fromId)! < 0);
      assert.ok(net.get(x.toId)! > 0);
      assert.ok(x.cents > 0);
      net.set(x.fromId, net.get(x.fromId)! + x.cents);
      net.set(x.toId, net.get(x.toId)! - x.cents);
    }
    for (const v of net.values()) assert.equal(v, 0);
  });
  test("four members: at most 3 transfers and all zeroed", () => {
    const b = [
      { memberId: "A", netCents: 700 },
      { memberId: "B", netCents: -200 },
      { memberId: "C", netCents: 300 },
      { memberId: "D", netCents: -800 },
    ];
    const t = settle(b);
    assert.ok(t.length <= 3);
    const net = new Map(b.map((x) => [x.memberId, x.netCents]));
    for (const x of t) {
      net.set(x.fromId, net.get(x.fromId)! + x.cents);
      net.set(x.toId, net.get(x.toId)! - x.cents);
    }
    for (const v of net.values()) assert.equal(v, 0);
    // first step: largest debtor D pays largest creditor A
    assert.deepEqual(t[0], { fromId: "D", toId: "A", cents: 700 });
  });
  test("all zero → empty", () => {
    assert.deepEqual(settle([{ memberId: "A", netCents: 0 }, { memberId: "B", netCents: 0 }]), []);
    assert.deepEqual(settle([]), []);
  });
});

describe("settleDirect", () => {
  const apply = (nets: Map<string, number>, ts: { fromId: string; toId: string; cents: number }[]) => {
    for (const t of ts) {
      nets.set(t.fromId, (nets.get(t.fromId) ?? 0) + t.cents);
      nets.set(t.toId, (nets.get(t.toId) ?? 0) - t.cents);
    }
    return nets;
  };
  const total = (ts: { cents: number }[]) => ts.reduce((a, t) => a + t.cents, 0);

  test("two expenses in opposite directions net into one transfer", () => {
    const members = ["A", "B"];
    const t = settleDirect(
      [
        { payerId: "A", amountCents: 100, splits: [{ memberId: "B", shareCents: 100 }] },
        { payerId: "B", amountCents: 30, splits: [{ memberId: "A", shareCents: 30 }] },
      ],
      members,
    );
    assert.deepEqual(t, [{ fromId: "B", toId: "A", cents: 70 }]);
  });

  test("a member who only owes cindy pays cindy once; same total and zeroing as settle", () => {
    const members = ["me", "pig", "cindy", "ami", "kaka", "guest"];
    const expenses = [
      // cindy paid 2400 split six ways → everyone else owes cindy 400
      { payerId: "cindy", amountCents: 240000, splits: splitEqual(240000, members) },
      // cross debts so greedy would reroute kaka's payment elsewhere
      { payerId: "me", amountCents: 90000, splits: splitEqual(90000, ["me", "pig", "ami"]) },
      { payerId: "pig", amountCents: 60000, splits: splitEqual(60000, ["me", "pig", "cindy", "ami"]) },
    ];
    const direct = settleDirect(expenses, members);
    const kaka = direct.filter((t) => t.fromId === "kaka" || t.toId === "kaka");
    assert.deepEqual(kaka, [{ fromId: "kaka", toId: "cindy", cents: 40000 }]);
    const guest = direct.filter((t) => t.fromId === "guest" || t.toId === "guest");
    assert.deepEqual(guest, [{ fromId: "guest", toId: "cindy", cents: 40000 }]);

    const bals = balances(expenses, members);
    const greedy = settle(bals);
    // Greedy's total equals Σ positive nets, the lower bound of any plan; direct routes
    // through intermediaries (A→B, B→C instead of A→C), so its total is ≥, not equal.
    assert.equal(total(greedy), bals.filter((b) => b.netCents > 0).reduce((a, b) => a + b.netCents, 0));
    assert.ok(total(direct) >= total(greedy));
    for (const plan of [direct, greedy]) {
      const nets = apply(new Map(bals.map((b) => [b.memberId, b.netCents])), plan);
      for (const [, n] of nets) assert.equal(n, 0);
    }
    // sorted: amount desc, ties by member order (from, then to)
    for (let i = 1; i < direct.length; i++) {
      const a = direct[i - 1]!;
      const b = direct[i]!;
      const ia = [members.indexOf(a.fromId), members.indexOf(a.toId)];
      const ib = [members.indexOf(b.fromId), members.indexOf(b.toId)];
      assert.ok(a.cents > b.cents || (a.cents === b.cents && (ia[0]! < ib[0]! || (ia[0] === ib[0] && ia[1]! < ib[1]!))));
    }
  });

  test("no expenses → empty", () => {
    assert.deepEqual(settleDirect([], ["A", "B"]), []);
  });

  test("payer's own share never produces a transfer", () => {
    const t = settleDirect([{ payerId: "A", amountCents: 100, splits: [{ memberId: "A", shareCents: 100 }] }], ["A"]);
    assert.deepEqual(t, []);
  });
});

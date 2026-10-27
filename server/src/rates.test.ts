import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MoneyError } from "./money.js";
import { CURRENCIES, CurrencyError, RATE_SCALE, convert, currency, formatRate, parseRate, seededRate } from "./rates.js";

describe("rates: parse / format", () => {
  it("parses up to 9 decimals with string arithmetic", () => {
    assert.equal(parseRate("1"), RATE_SCALE);
    assert.equal(parseRate("0.0312"), 31_200_000n);
    assert.equal(parseRate("32.123456789"), 32_123_456_789n);
    assert.equal(formatRate(31_200_000n), "0.0312");
    assert.equal(formatRate(RATE_SCALE), "1");
    assert.equal(formatRate(parseRate("32.5")), "32.5");
  });
  it("rejects zero, negatives, too many decimals, junk", () => {
    for (const bad of ["0", "0.0", "-1", "1.1234567891", "abc", "1,5", ""]) {
      assert.throws(() => parseRate(bad), CurrencyError, bad);
    }
  });
});

describe("rates: seeded table", () => {
  it("every currency has sane decimals and a positive USD rate; USD is 1", () => {
    for (const c of CURRENCIES) {
      assert.ok([0, 2, 3].includes(c.decimals), c.code);
      assert.ok(c.usdPerUnit > 0n, c.code);
    }
    assert.equal(currency("USD").usdPerUnit, RATE_SCALE);
    assert.throws(() => currency("XXX"), CurrencyError);
  });
  it("cross rate goes through USD; identity is exactly 1", () => {
    assert.equal(seededRate("TWD", "TWD"), RATE_SCALE);
    // 1 USD = 1 / 0.031 TWD = 32.258064516…
    assert.equal(formatRate(seededRate("USD", "TWD")), "32.258064516");
    assert.equal(formatRate(seededRate("TWD", "USD")), "0.031");
    // JPY → TWD = 0.0067 / 0.031
    assert.equal(formatRate(seededRate("JPY", "TWD")), "0.216129032");
  });
});

describe("rates: convert", () => {
  it("identity rate returns the same amount", () => {
    assert.equal(convert(12345, "USD", "USD", RATE_SCALE), 12345);
    assert.equal(convert(1200, "TWD", "TWD", RATE_SCALE), 1200);
  });
  it("USD cents → TWD whole units: $37.44 at 32.258064516 = 1208", () => {
    // 3744 cents = $37.44; × 32.258064516 = 1207.74 TWD → 1208
    assert.equal(convert(3744, "USD", "TWD", seededRate("USD", "TWD")), 1208);
  });
  it("TWD → USD cents: 1200 TWD at 0.031 = $37.20", () => {
    assert.equal(convert(1200, "TWD", "USD", parseRate("0.031")), 3720);
  });
  it("rounds half-up at the target minor unit", () => {
    // 1 TWD at 0.005 USD = 0.5 cent → 1 cent
    assert.equal(convert(1, "TWD", "USD", parseRate("0.005")), 1);
    // 1 TWD at 0.004 → 0.4 cent → 0
    assert.equal(convert(1, "TWD", "USD", parseRate("0.004")), 0);
    // 0-decimal target: 150 JPY at 0.2165 TWD = 32.475 → 32; at 0.2167 = 32.505 → 33
    assert.equal(convert(150, "JPY", "TWD", parseRate("0.2165")), 32);
    assert.equal(convert(150, "JPY", "TWD", parseRate("0.2167")), 33);
  });
  it("round trip USD → TWD → USD is within one TWD unit of error", () => {
    const toTwd = seededRate("USD", "TWD");
    const toUsd = seededRate("TWD", "USD");
    const twd = convert(10_000, "USD", "TWD", toTwd); // $100 → 3226
    const back = convert(twd, "TWD", "USD", toUsd); // 3226 × 0.031 = 100.006 → 10001
    assert.equal(twd, 3226);
    assert.ok(Math.abs(back - 10_000) <= 4, `back=${back}`); // ≤ 1 TWD ≈ 3.1 cents
  });
  it("rejects non-positive rates and guards the maximum", () => {
    assert.throws(() => convert(100, "USD", "TWD", 0n), CurrencyError);
    assert.throws(() => convert(1_000_000_000, "USD", "KRW", seededRate("USD", "KRW")), MoneyError);
    assert.throws(() => convert(-1, "USD", "USD", RATE_SCALE), MoneyError);
  });
});

// Converter bottom sheet: amount + from/to over the group's rate table (override first), a
// "1 <from> =" glance list, and the editable rate table itself. Every rate is "base per 1 unit",
// so a cross rate X → Y is rateX / rateY; the math is convertPreview's BigInt half-up.
import { useEffect, useState } from "react";
import { api, type Rates } from "../api";
import { isComposingEnter } from "../keys";
import { convertPreview, decimalsOf, formatMoney, parseMinor, parseRate, shortRate } from "../money";
import { readLastCurrency } from "./ExpenseSheet";

interface Props {
  groupId: string;
  rates: Rates;
  onClose: () => void;
  /** Called after a rate PUT/DELETE; SSE would also refresh the view. */
  onRatesChanged: () => Promise<void>;
}

export function Converter({ groupId, rates, onClose, onRatesChanged }: Props) {
  const base = rates.base;
  const codes = [base, ...rates.table.map((r) => r.currency)];
  const rateOf = (code: string) => (code === base ? "1" : (rates.table.find((r) => r.currency === code)?.rate ?? "1"));
  const last = readLastCurrency(groupId);
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState(base);
  const [to, setTo] = useState(last && last !== base && codes.includes(last) ? last : (rates.table[0]?.currency ?? base));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const fromDec = decimalsOf(from);
  const minor = parseMinor(amount, fromDec);
  const conv = (code: string) =>
    minor === null ? null : convertPreview(minor, fromDec, decimalsOf(code), rateOf(from), rateOf(code));
  const result = conv(to);
  const unitRate = (code: string) => shortRate(String(Number(rateOf(from)) / Number(rateOf(code))));

  async function run(code: string, fn: () => Promise<unknown>) {
    setBusy(code);
    setError(null);
    try {
      await fn();
      setDrafts(({ [code]: _, ...rest }) => rest);
      await onRatesChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function commit(code: string) {
    const draft = drafts[code];
    if (draft === undefined) return;
    const t = draft.trim();
    if (t === rateOf(code)) {
      setDrafts(({ [code]: _, ...rest }) => rest);
      return;
    }
    if (parseRate(t) === null) {
      setError(`${code}: enter a rate like 0.2161 (up to 9 decimals, > 0)`);
      return;
    }
    void run(code, () => api.setRate(groupId, code, t));
  }

  const swap = () => {
    setFrom(to);
    setTo(from);
  };

  return (
    <div className="sheet-root" role="dialog" aria-modal="true" aria-labelledby="conv-title">
      <div className="dim" onClick={onClose} />
      <div className="sheet">
        <div className="handle" />
        <div className="sheet-h">
          <h3 id="conv-title">Converter</h3>
          <button type="button" className="keep" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="sheet-body conv-body">
          <div className="field">
            <label htmlFor="c-amount">Amount</label>
            <div className={`input amount ${amount.trim() && minor === null ? "invalid" : ""}`}>
              <select className="cur-select" aria-label="From currency" value={from} onChange={(e) => setFrom(e.target.value)}>
                {codes.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <input
                id="c-amount"
                type="text"
                inputMode={fromDec === 0 ? "numeric" : "decimal"}
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
          <div className="conv-to">
            <button type="button" className="keep" onClick={swap} aria-label="Swap currencies">
              ⇅
            </button>
            <span>to</span>
            <select className="input select mini-select" aria-label="To currency" value={to} onChange={(e) => setTo(e.target.value)}>
              {codes.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="conv-result" role="status">
            {result === null ? "—" : `≈ ${formatMoney(result, to)}`}
            <span className="meta">
              1 {from} = {unitRate(to)} {to}
            </span>
          </div>

          <div className="card-h mt">
            <h2>1 {from} =</h2>
            {minor !== null && <span className="meta">and {formatMoney(minor, from)} =</span>}
          </div>
          <div className="glance">
            {codes
              .filter((c) => c !== from)
              .map((c) => (
                <div className="glance-row" key={c}>
                  <span className="code">{c}</span>
                  <span className="r">{unitRate(c)}</span>
                  <span className="amt">{conv(c) === null ? "—" : formatMoney(conv(c)!, c)}</span>
                </div>
              ))}
          </div>

          <div className="card-h mt">
            <h2>Rates · {base} per 1 unit</h2>
          </div>
          <div className="hint">Seeded rates are approximate; set your own from your card statement.</div>
          <div className="rate-rows">
            {rates.table.map((r) => (
              <div className="rate-row" key={r.currency}>
                <span className="code" title={r.name}>
                  {r.currency}
                </span>
                <input
                  className={`input mini rate ${drafts[r.currency] !== undefined && parseRate(drafts[r.currency]!) === null ? "invalid" : ""}`}
                  aria-label={`${base} per 1 ${r.currency}`}
                  type="text"
                  inputMode="decimal"
                  disabled={busy === r.currency}
                  value={drafts[r.currency] ?? r.rate}
                  onChange={(e) => setDrafts({ ...drafts, [r.currency]: e.target.value })}
                  onBlur={() => commit(r.currency)}
                  onKeyDown={(e) => {
                    if (isComposingEnter(e)) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commit(r.currency);
                    }
                  }}
                />
                {r.source === "override" ? (
                  <button
                    type="button"
                    className="linklike"
                    disabled={busy === r.currency}
                    onClick={() => void run(r.currency, () => api.deleteRate(groupId, r.currency))}
                  >
                    Reset to seed
                  </button>
                ) : (
                  <span className="tag">seed</span>
                )}
              </div>
            ))}
          </div>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

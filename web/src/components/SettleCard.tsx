import { useState, type ReactNode } from "react";
import type { GroupView, Transfer } from "../api";
import { formatCents } from "../money";
import { Avatar } from "./Avatar";

type SettleMode = "fewest" | "direct";
const MODE_KEY = "settleMode"; // per browser, not per group (SPEC "Frontend")

function readMode(): SettleMode {
  try {
    return localStorage.getItem(MODE_KEY) === "direct" ? "direct" : "fewest";
  } catch {
    return "fewest";
  }
}

const MODES: { id: SettleMode; label: string }[] = [
  { id: "fewest", label: "Fewest payments" },
  { id: "direct", label: "Pay who paid for you" },
];

interface Props {
  view: GroupView;
  onAddMember: () => void;
  /** Records a settlement for exactly this plan row (SPEC "Settlements are payments, not flags"). */
  onMarkPaid: (t: Transfer) => Promise<void>;
}

const rowKey = (t: Transfer) => `${t.fromId}-${t.toId}`;

export function SettleCard({ view, onAddMember, onMarkPaid }: Props) {
  const idx = new Map(view.members.map((m, i) => [m.id, i]));
  const name = (id: string) => view.members[idx.get(id) ?? -1]?.name ?? "?";
  const [mode, setMode] = useState<SettleMode>(readMode);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pay(t: Transfer) {
    const k = rowKey(t);
    setBusyKey(k);
    setError(null);
    try {
      await onMarkPaid(t);
      setConfirmKey(null); // the row disappears or shrinks once the view refetches
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  }
  const pick = (m: SettleMode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* private mode / storage blocked: selection just won't persist */
    }
  };
  // Both plans ship in the view; switching never hits the API.
  const transfers = mode === "direct" ? view.settlementDirect : view.settlement;
  const n = transfers.length;

  let body: ReactNode;
  if (view.members.length === 0) {
    body = (
      <div className="empty">
        No members yet.{" "}
        <button type="button" className="linklike" onClick={onAddMember}>
          Add the first member
        </button>{" "}
        to start splitting.
      </div>
    );
  } else if (view.expenses.length === 0) {
    body = <div className="empty">No expenses yet — tap “+ Add expense” below.</div>;
  } else if (n === 0) {
    body = <div className="done">All settled 🎉</div>;
  } else {
    body = transfers.map((t) =>
      confirmKey === rowKey(t) ? (
        <div className="row" key={rowKey(t)}>
          <div className="confirm-row">
            <span>
              Record {name(t.fromId)} → {name(t.toId)} <b className="amt">{formatCents(t.cents)}</b> as paid?
            </span>
            <span className="confirm-actions">
              <button type="button" className="paid" disabled={busyKey === rowKey(t)} onClick={() => void pay(t)}>
                {busyKey === rowKey(t) ? "Saving…" : "Paid"}
              </button>
              <button type="button" className="keep" onClick={() => setConfirmKey(null)}>
                Cancel
              </button>
            </span>
          </div>
        </div>
      ) : (
      <div className="row" key={rowKey(t)}>
        <div className="flow">
          <span className="who">
            <Avatar name={name(t.fromId)} index={idx.get(t.fromId) ?? 0} />
            <span className="name">{name(t.fromId)}</span>
          </span>
          <span className="arrow" aria-label="pays">
            →
          </span>
          <span className="who">
            <Avatar name={name(t.toId)} index={idx.get(t.toId) ?? 0} />
            <span className="name">{name(t.toId)}</span>
          </span>
        </div>
        <span className="amt">{formatCents(t.cents)}</span>
        <button
          type="button"
          className="mark-paid"
          aria-label={`Mark ${name(t.fromId)} → ${name(t.toId)} ${formatCents(t.cents)} as paid`}
          onClick={() => setConfirmKey(rowKey(t))}
        >
          <span className="txt">Mark paid</span>
          <span className="ico" aria-hidden="true">✓</span>
        </button>
      </div>
      ),
    );
  }

  return (
    <section className="card settle" aria-labelledby="settle-h">
      <div className="card-h">
        <h2 id="settle-h">Settle up</h2>
        {n > 0 && (
          <span className="meta">
            {n} {n === 1 ? "payment settles" : "payments settle"} everyone
          </span>
        )}
      </div>
      {view.expenses.length > 0 && (
        <div className="seg settle-mode" role="tablist" aria-label="Settle mode">
          {MODES.map((m) => (
            <button
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              className={mode === m.id ? "on" : ""}
              key={m.id}
              onClick={() => pick(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
      {body}
      {error && (
        <div className="hint warn" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

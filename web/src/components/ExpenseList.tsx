import { useState } from "react";
import type { Expense, GroupView } from "../api";
import { formatCents } from "../money";

interface Props {
  view: GroupView;
  onEdit: (e: Expense) => void;
  onDelete: (e: Expense) => Promise<void>;
}

function splitLabel(e: Expense, view: GroupView): string {
  if (e.splitMode === "equal") return `split equally · ${e.splits.length}`;
  if (e.splitMode === "exact") return "exact amounts";
  const order = new Map(view.members.map((m, i) => [m.id, i]));
  const pcts = [...e.splits]
    .sort((a, b) => (order.get(a.memberId) ?? 0) - (order.get(b.memberId) ?? 0))
    .map((s) => s.inputValue ?? "?");
  return `${pcts.join(" / ")} %`;
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function ExpenseList({ view, onEdit, onDelete }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => view.members.find((m) => m.id === id)?.name ?? "?";

  async function del(e: Expense) {
    setBusyId(e.id);
    setError(null);
    try {
      await onDelete(e);
      setConfirmId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card exp" aria-labelledby="exp-h">
      <div className="card-h">
        <h2 id="exp-h">Expenses</h2>
        <span className="meta">newest first</span>
      </div>
      {view.expenses.length === 0 ? (
        <div className="empty">
          {view.members.length === 0
            ? "Add members first, then log the first expense."
            : "Nothing logged yet. Tap “+ Add expense” to record the first one."}
        </div>
      ) : (
        view.expenses.map((e) => (
          <div className="row" key={e.id}>
            {confirmId === e.id ? (
              <div className="confirm-row">
                <span>Delete “{e.description}”?</span>
                <span className="confirm-actions">
                  <button type="button" className="danger" disabled={busyId === e.id} onClick={() => void del(e)}>
                    Delete
                  </button>
                  <button type="button" className="keep" onClick={() => setConfirmId(null)}>
                    Keep
                  </button>
                </span>
              </div>
            ) : (
              <>
                <button type="button" className="exp-main" onClick={() => onEdit(e)}>
                  <div className="desc">{e.description}</div>
                  <div className="meta">
                    {name(e.payerId)} paid · {splitLabel(e, view)} · {dateLabel(e.createdAt)}
                  </div>
                </button>
                <span className="amt">{formatCents(e.amountCents)}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Delete ${e.description}`}
                  onClick={() => setConfirmId(e.id)}
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))
      )}
      {error && (
        <div className="hint warn" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

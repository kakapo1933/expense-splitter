import { useCallback, useState } from "react";
import { api, type Expense, type ExpenseInput } from "../api";
import { BalancesCard } from "../components/BalancesCard";
import { ExpenseList } from "../components/ExpenseList";
import { ExpenseSheet } from "../components/ExpenseSheet";
import { Header } from "../components/Header";
import { SettleCard } from "../components/SettleCard";
import { navigate } from "../router";
import { useGroup } from "../useGroup";

type Sheet = { open: false } | { open: true; expense?: Expense };

export function GroupPage({ id }: { id: string }) {
  const { view, error, notFound, live, refetch } = useGroup(id);
  const [sheet, setSheet] = useState<Sheet>({ open: false });
  const [addMemberSignal, setAddMemberSignal] = useState(0);

  const closeSheet = useCallback(() => setSheet({ open: false }), []);

  const addMember = useCallback(
    async (name: string) => {
      await api.addMember(id, name);
      await refetch(); // SSE will also fire; refetch() coalesces
    },
    [id, refetch],
  );

  const save = useCallback(
    async (input: ExpenseInput) => {
      if (sheet.open && sheet.expense) await api.updateExpense(id, sheet.expense.id, input);
      else await api.createExpense(id, input);
      await refetch();
    },
    [id, refetch, sheet],
  );

  const remove = useCallback(
    async (e: Expense) => {
      await api.deleteExpense(id, e.id);
      await refetch();
    },
    [id, refetch],
  );

  if (notFound) {
    return (
      <main className="center">
        <h1>Group not found</h1>
        <p>This link doesn't point to a group. It may have been created on another server.</p>
        <button type="button" className="btn primary block" onClick={() => navigate("/")}>
          Create a new group
        </button>
      </main>
    );
  }
  if (!view) {
    return (
      <main className="center">
        <p role="status">{error ?? "Loading…"}</p>
        {error && (
          <button type="button" className="btn ghost block" onClick={() => void refetch()}>
            Retry
          </button>
        )}
      </main>
    );
  }

  const hasMembers = view.members.length > 0;

  return (
    <div className="app">
      <Header view={view} live={live} onAddMember={addMember} addSignal={addMemberSignal} />
      <main className="scroll">
        {error && (
          <div className="error-box" role="alert">
            Couldn't refresh: {error}
          </div>
        )}
        <SettleCard view={view} onAddMember={() => setAddMemberSignal((n) => n + 1)} />
        <BalancesCard view={view} />
        <ExpenseList view={view} onEdit={(e) => setSheet({ open: true, expense: e })} onDelete={remove} />
      </main>
      <button
        type="button"
        className="fab"
        disabled={!hasMembers}
        title={hasMembers ? undefined : "Add a member first"}
        onClick={() => setSheet({ open: true })}
      >
        ＋ Add expense
      </button>
      {sheet.open && (
        <ExpenseSheet
          groupId={id}
          members={view.members}
          expense={sheet.expense}
          onSave={save}
          onDelete={sheet.expense ? () => remove(sheet.expense!) : undefined}
          onClose={closeSheet}
        />
      )}
    </div>
  );
}

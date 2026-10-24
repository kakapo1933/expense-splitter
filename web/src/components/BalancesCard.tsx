import type { GroupView } from "../api";
import { formatSigned } from "../money";
import { Avatar } from "./Avatar";

export function BalancesCard({ view }: { view: GroupView }) {
  const byId = new Map(view.balances.map((b) => [b.memberId, b]));
  return (
    <section className="card" aria-labelledby="bal-h">
      <div className="card-h">
        <h2 id="bal-h">Balances</h2>
        <span className="meta">paid − share</span>
      </div>
      {view.members.length === 0 ? (
        <div className="empty">Add members to see who owes whom.</div>
      ) : (
        view.members.map((m, i) => {
          const net = byId.get(m.id)?.netCents ?? 0;
          const cls = net > 0 ? "pos" : net < 0 ? "neg" : "zero";
          const word = net > 0 ? "gets back" : net < 0 ? "owes" : "settled";
          return (
            <div className="row" key={m.id}>
              <span className="who">
                <Avatar name={m.name} index={i} />
                {m.name}
              </span>
              <span className={`pill amt ${cls}`}>
                {net === 0 ? word : `${formatSigned(net)} ${word}`}
              </span>
            </div>
          );
        })
      )}
    </section>
  );
}

import type { GroupView, Member } from "../api";
import { formatSigned } from "../money";
import { Avatar } from "./Avatar";

export function BalancesCard({ view }: { view: GroupView }) {
  const byId = new Map(view.balances.map((b) => [b.memberId, b]));
  const idx = new Map(view.members.map((m, i) => [m.id, i]));
  // Active members first, then a "Left" subheading (SPEC "Leaving is a flag, not a delete").
  const active = view.members.filter((m) => !m.leftAt);
  const left = view.members.filter((m) => m.leftAt);
  const row = (m: Member) => {
    const net = byId.get(m.id)?.netCents ?? 0;
    const cls = net > 0 ? "pos" : net < 0 ? "neg" : "zero";
    const word = net > 0 ? "gets back" : net < 0 ? "owes" : "settled";
    return (
      <div className="row" key={m.id}>
        <span className="who">
          <Avatar name={m.name} index={idx.get(m.id) ?? 0} />
          {m.name}
          {m.leftAt && <span className="tag">left</span>}
        </span>
        <span className={`pill amt ${cls}`}>{net === 0 ? word : `${formatSigned(net)} ${word}`}</span>
      </div>
    );
  };
  return (
    <section className="card" aria-labelledby="bal-h">
      <div className="card-h">
        <h2 id="bal-h">Balances</h2>
        <span className="meta">paid − share</span>
      </div>
      {view.members.length === 0 ? (
        <div className="empty">Add members to see who owes whom.</div>
      ) : (
        <>
          {active.map(row)}
          {left.length > 0 && (
            <>
              <div className="subhead">Left</div>
              {left.map(row)}
            </>
          )}
        </>
      )}
    </section>
  );
}

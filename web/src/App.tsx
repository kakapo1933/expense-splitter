import { useEffect, useState } from "react";

export function App() {
  const [health, setHealth] = useState<string>("loading…");

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => setHealth(JSON.stringify(data)))
      .catch((err: unknown) => setHealth(`error: ${String(err)}`));
  }, []);

  return (
    <main>
      <h1>Expense Splitter</h1>
      <p>
        <code>GET /api/health</code> → <code>{health}</code>
      </p>
    </main>
  );
}

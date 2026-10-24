import { CreateGroup } from "./pages/CreateGroup";
import { GroupPage } from "./pages/GroupPage";
import { navigate, useRoute } from "./router";

export function App() {
  const route = useRoute();
  if (route.kind === "home") return <CreateGroup />;
  if (route.kind === "group") return <GroupPage key={route.id} id={route.id} />;
  return (
    <main className="center">
      <h1>Page not found</h1>
      <button type="button" className="btn primary block" onClick={() => navigate("/")}>
        Go home
      </button>
    </main>
  );
}

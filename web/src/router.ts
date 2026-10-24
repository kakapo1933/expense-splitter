// Two routes, no library: "/" and "/g/:id". pushState for in-app navigation, popstate for back.
import { useEffect, useState } from "react";

export type Route = { kind: "home" } | { kind: "group"; id: string } | { kind: "missing" };

export function parse(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { kind: "home" };
  const m = /^\/g\/([^/]+)\/?$/.exec(pathname);
  if (m?.[1]) return { kind: "group", id: decodeURIComponent(m[1]) };
  return { kind: "missing" };
}

const listeners = new Set<() => void>();

export function navigate(to: string) {
  history.pushState(null, "", to);
  listeners.forEach((fn) => fn());
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname));
  useEffect(() => {
    const update = () => setRoute(parse(location.pathname));
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return route;
}

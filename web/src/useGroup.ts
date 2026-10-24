// Load a group and keep it fresh over SSE. `changed` → refetch; after a reconnect (`hello`
// arriving again) → refetch once, since writes may have happened while the stream was down.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type GroupView } from "./api";

export type LiveState = "connecting" | "live" | "reconnecting";

export interface GroupState {
  view: GroupView | null;
  error: string | null;
  notFound: boolean;
  live: LiveState;
  refetch: () => Promise<void>;
}

export function useGroup(id: string): GroupState {
  const [view, setView] = useState<GroupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [live, setLive] = useState<LiveState>("connecting");
  const inflight = useRef<Promise<void> | null>(null);

  const refetch = useCallback(async () => {
    // Coalesce bursts of `changed` events into one request at a time.
    if (inflight.current) return inflight.current;
    const p = api
      .getGroup(id)
      .then((v) => {
        setView(v);
        setError(null);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
        else setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        inflight.current = null;
      });
    inflight.current = p;
    return p;
  }, [id]);

  useEffect(() => {
    setView(null);
    setNotFound(false);
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const es = new EventSource(api.eventsUrl(id));
    let everConnected = false;
    es.addEventListener("hello", () => {
      setLive("live");
      if (everConnected) void refetch(); // reconnected: catch up on anything missed
      everConnected = true;
    });
    es.addEventListener("changed", () => void refetch());
    es.onerror = () => setLive("reconnecting"); // EventSource retries by itself
    return () => es.close();
  }, [id, refetch]);

  return { view, error, notFound, live, refetch };
}

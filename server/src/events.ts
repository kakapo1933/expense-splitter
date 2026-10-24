// In-process pub/sub, one subscriber set per group. Used by the SSE endpoint.
type Send = () => void;

const subscribers = new Map<string, Set<Send>>();

export function subscribe(groupId: string, send: Send): () => void {
  let set = subscribers.get(groupId);
  if (!set) {
    set = new Set();
    subscribers.set(groupId, set);
  }
  set.add(send);
  return () => {
    set!.delete(send);
    if (set!.size === 0) subscribers.delete(groupId);
  };
}

/** Notify every open stream for the group that something changed. */
export function publish(groupId: string): void {
  const set = subscribers.get(groupId);
  if (!set) return;
  for (const send of set) {
    try {
      send();
    } catch {
      // a dead subscriber must not break the others; it will be removed on abort
    }
  }
}

export function subscriberCount(groupId: string): number {
  return subscribers.get(groupId)?.size ?? 0;
}

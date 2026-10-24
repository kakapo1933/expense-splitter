// HTTP layer only: parse → service → JSON. Validation errors are thrown and mapped in index.ts.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ZodType } from "zod";
import { publish, subscribe } from "./events.js";
import { ExpenseInput, NameInput } from "./schemas.js";
import type { Service } from "./service.js";

const KEEPALIVE_MS = 25_000;

async function parseBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const body: unknown = await req.json(); // SyntaxError on bad JSON → 400 in onError
  const result = schema.safeParse(body);
  if (!result.success) throw result.error; // ZodError → 400 in onError
  return result.data;
}

export function createRoutes(svc: Service) {
  const api = new Hono();

  api.post("/groups", async (c) => {
    const { name } = await parseBody(c.req.raw, NameInput);
    return c.json(svc.createGroup(name), 201);
  });

  api.get("/groups/:id", (c) => c.json(svc.getGroupView(c.req.param("id"))));

  api.post("/groups/:id/members", async (c) => {
    const groupId = c.req.param("id");
    const { name } = await parseBody(c.req.raw, NameInput);
    const member = svc.addMember(groupId, name);
    publish(groupId);
    return c.json(member, 201);
  });

  api.post("/groups/:id/expenses", async (c) => {
    const groupId = c.req.param("id");
    const input = await parseBody(c.req.raw, ExpenseInput);
    const expense = svc.createExpense(groupId, input);
    publish(groupId);
    return c.json(expense, 201);
  });

  api.put("/groups/:id/expenses/:eid", async (c) => {
    const { id: groupId, eid } = c.req.param();
    const input = await parseBody(c.req.raw, ExpenseInput);
    const expense = svc.updateExpense(groupId, eid, input);
    publish(groupId);
    return c.json(expense);
  });

  api.delete("/groups/:id/expenses/:eid", (c) => {
    const { id: groupId, eid } = c.req.param();
    svc.deleteExpense(groupId, eid);
    publish(groupId);
    return c.body(null, 204);
  });

  // SSE: `hello` on connect, `changed` after any write to this group, comment every 25s as keep-alive.
  api.get("/groups/:id/events", (c) => {
    const groupId = c.req.param("id");
    svc.getGroupView(groupId); // 404 for unknown group before the stream opens
    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: "hello", data: groupId });
      const unsubscribe = subscribe(groupId, () => {
        void stream.writeSSE({ event: "changed", data: new Date().toISOString() });
      });
      const timer = setInterval(() => void stream.write(": keep-alive\n\n"), KEEPALIVE_MS);
      await new Promise<void>((resolve) => {
        const cleanup = () => {
          clearInterval(timer);
          unsubscribe();
          resolve();
        };
        stream.onAbort(cleanup);
        c.req.raw.signal.addEventListener("abort", cleanup, { once: true });
      });
    });
  });

  return api;
}

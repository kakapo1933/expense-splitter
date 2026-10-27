import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { openDb } from "./db.js";
import { ConflictError, GroupNotEmptyError, NotFoundError, SameMemberError, UnknownMemberError } from "./errors.js";
import { CurrencyError } from "./rates.js";
import { MoneyError } from "./money.js";
import { createRoutes } from "./routes.js";
import { createService } from "./service.js";

const db = openDb();
const svc = createService(db);

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api", createRoutes(svc));

app.notFound((c) => c.json({ error: "NOT_FOUND", message: `no route for ${c.req.method} ${c.req.path}` }, 404));

app.onError((err, c) => {
  if (err instanceof ZodError) {
    return c.json({ error: "VALIDATION", issues: err.issues }, 400);
  }
  if (
    err instanceof MoneyError ||
    err instanceof CurrencyError ||
    err instanceof UnknownMemberError ||
    err instanceof SameMemberError
  ) {
    return c.json({ error: err.code, message: err.message }, 400);
  }
  if (err instanceof SyntaxError) {
    return c.json({ error: "INVALID_JSON", message: "request body is not valid JSON" }, 400);
  }
  if (err instanceof NotFoundError) {
    return c.json({ error: "NOT_FOUND", message: err.message }, 404);
  }
  if (err instanceof ConflictError || err instanceof GroupNotEmptyError) {
    return c.json({ error: err.code, message: err.message }, 409);
  }
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error(err); // full stack to the server log only
  return c.json({ error: "INTERNAL", message: "internal server error" }, 500);
});

// Production: serve the built SPA from ../web/dist when it exists.
// `@hono/node-server/serve-static` joins root + request path with node:path.join,
// so an absolute root works and nothing depends on process.cwd().
const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../../web/dist");
if (process.env.NODE_ENV === "production" && existsSync(webDist)) {
  app.use("/*", serveStatic({ root: webDist }));
  app.get("*", serveStatic({ root: webDist, path: "index.html" }));
}

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});

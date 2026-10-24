import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

// Production: serve the built SPA from ../web/dist when it exists.
// `serveStatic` root is relative to process.cwd(), so compute it from this file
// and convert to a cwd-relative path to stay independent of where `node` is run.
const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, "../../web/dist");
if (process.env.NODE_ENV === "production" && existsSync(webDist)) {
  const root = resolve(webDist).replace(process.cwd() + "/", "./");
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`server listening on http://localhost:${info.port}`);
});

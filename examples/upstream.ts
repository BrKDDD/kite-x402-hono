import { Hono } from "hono";

const app = new Hono();
app.get("/echo", (c) =>
  c.json({
    message: c.req.query("message") ?? "Hello from Kite",
    method: c.req.method,
  }),
);
app.post("/echo", async (c) =>
  c.json({ body: await c.req.text(), method: c.req.method }),
);
app.get("/fail", (c) =>
  c.json({ error: "demonstration_upstream_failure" }, 503),
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 8081,
  fetch: app.fetch,
});
console.log(`Example upstream: ${server.url}`);

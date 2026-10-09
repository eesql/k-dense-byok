import http from "node:http";
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AccessError } from "./store.ts";

const hopHeaders = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
export async function proxyRequest(req: FastifyRequest, reply: FastifyReply, base: string, url: string, overrides: Record<string, string> = {}) {
  const target = new URL(url, base);
  if (target.origin !== new URL(base).origin) throw new AccessError(400, "invalid_proxy_target");
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) if (!hopHeaders.has(key) && !["host", "authorization", "x-kady-token"].includes(key)) headers[key] = value;
  Object.assign(headers, overrides, { host: target.host });
  let body: Buffer | Readable | undefined;
  if (req.body !== undefined) body = req.body instanceof Readable ? req.body : Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
  if (Buffer.isBuffer(body)) headers["content-length"] = String(body.length); else if (!body) delete headers["content-length"];
  await new Promise<void>((resolve, reject) => {
    const upstream = http.request(target, { method: req.method, headers }, response => {
      reply.hijack();
      const forwarded: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(response.headers)) if (!hopHeaders.has(key)) forwarded[key] = value;
      reply.raw.writeHead(response.statusCode ?? 502, forwarded);
      response.on("error", () => { reply.raw.destroy(); resolve(); });
      response.on("end", resolve);
      response.pipe(reply.raw);
    });
    upstream.on("error", () => {
      if (reply.raw.headersSent) { reply.raw.destroy(); resolve(); }
      else reject(new AccessError(502, "backend_unavailable"));
    });
    reply.raw.on("close", () => { upstream.destroy(); resolve(); });
    if (body) (body instanceof Readable ? body : Readable.from(body)).on("error", () => upstream.destroy()).pipe(upstream); else upstream.end();
  });
}

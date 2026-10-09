import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { AccessError, TenantStore, text, type Identity, type ManagedProject } from "./store.ts";
import { ModelGateway } from "./model-gateway.ts";
import { WorkerFleet } from "./workers.ts";
import { digest } from "./store.ts";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { proxyRequest } from "./proxy.ts";
import { startsManagedWork } from "./operations.ts";

const COOKIE = "kady_session";
function cookies(req: FastifyRequest): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    try { values.set(part.slice(0, at).trim(), decodeURIComponent(part.slice(at + 1).trim())); } catch { throw new AccessError(400, "invalid_cookie"); }
  }
  return values;
}
function payload(req: FastifyRequest): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Buffer.isBuffer(req.body)) throw new AccessError(400, "invalid_body");
  return req.body as Record<string, unknown>;
}
function workerToken(req: FastifyRequest) { return req.headers.authorization?.match(/^Bearer ([\w-]{40,128})$/i)?.[1] ?? ""; }

export async function buildManagementApp(options: {
  store: TenantStore; publicUrl: string; managerUrl: string; uiUrl?: string;
  fleet?: WorkerFleet; gateway?: ModelGateway;
}): Promise<FastifyInstance> {
  const { store } = options;
  const publicUrl = new URL(options.publicUrl);
  if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) throw new Error("KADY_PUBLIC_URL must be an origin");
  if (publicUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname)) throw new Error("LAN deployment requires an HTTPS public URL");
  const secure = publicUrl.protocol === "https:" ? "; Secure" : "";
  const lockFile = path.join(store.root, "manager.lock"), ownership = JSON.stringify({ pid: process.pid, token: randomUUID() });
  if (fs.existsSync(lockFile)) {
    const pid = JSON.parse(fs.readFileSync(lockFile, "utf8")).pid;
    if (!Number.isInteger(pid) || pid < 1) throw new Error("Invalid manager lock; inspect it before restarting");
    try { process.kill(pid, 0); throw new AccessError(409, "manager_already_running"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    fs.rmSync(lockFile);
  }
  fs.writeFileSync(lockFile, ownership, { flag: "wx", mode: 0o600 });
  store.recover();
  const fleet = options.fleet ?? new WorkerFleet(store, options.managerUrl, publicUrl.origin);
  const gateway = options.gateway ?? new ModelGateway(store);
  const app = Fastify({ logger: false, bodyLimit: 96 * 1024 * 1024 });
  // Preserve the backend's multipart/file limits without buffering whole uploads in the manager.
  app.addContentTypeParser(/^multipart\/form-data/, (_req, stream, done) => done(null, stream));
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.setErrorHandler((error, _req, reply) => {
    if (reply.raw.headersSent) return reply.raw.destroy();
    if (error instanceof AccessError) {
      if (error.reason === "login_required") reply.header("X-Kady-Session", "expired");
      return reply.code(error.status).send({ reason: error.reason, detail: error.message });
    }
    return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ reason: "request_failed", detail: "Request failed" });
  });
  const identity = (req: FastifyRequest) => store.authenticate(cookies(req).get(COOKIE));
  const meta = (project: ManagedProject) => ({ ...JSON.parse(project.meta), tenantId: project.tenantId, supply: project.supply, pendingCredentials: fleet.live.get(project.id)?.pending ?? false });
  const authenticateWorker = (req: FastifyRequest) => store.workerProject(workerToken(req));
  const observers = new Map<string, { userId: string; responses: Set<ServerResponse> }>();
  const revokeObservers = (userId: string) => {
    for (const record of observers.values()) if (record.userId === userId) for (const response of record.responses) response.destroy();
  };
  const throttle = new Map<string, { count: number; until: number }>();
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/")) return;
    const internal = url.startsWith("/api/internal/") || url.startsWith("/api/platform/");
    if (internal) {
      // Browsers cannot use the callback credential as a user credential.
      if (req.headers.origin) throw new AccessError(403, "internal_only");
      authenticateWorker(req);
      return;
    }
    const origin = req.headers.origin;
    const host = req.headers.host?.toLowerCase();
    if (host !== publicUrl.host && host !== new URL(options.managerUrl).host) throw new AccessError(403, "invalid_host");
    if (origin && origin !== publicUrl.origin) throw new AccessError(403, "invalid_origin");
    if (req.headers["sec-fetch-site"] === "cross-site") throw new AccessError(403, "cross_site_request");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && origin !== publicUrl.origin) throw new AccessError(403, "origin_required");
    if (url === "/api/management/login" || url === "/api/management/join") {
      const key = `${req.ip}:${url}`, now = store.now();
      if (throttle.size > 5000) for (const [key, value] of throttle) if (value.until < now) throttle.delete(key);
      if (throttle.size > 10000) throw new AccessError(429, "rate_limited");
      const count = throttle.get(key);
      if (!count || count.until <= now) throttle.set(key, { count: 1, until: now + 60000 });
      else if (++count.count > 10) throw new AccessError(429, "rate_limited");
    }
    if (!["/api/management/mode", "/api/management/login", "/api/management/join"].includes(url)) {
      const user = identity(req), session = cookies(req).get(COOKIE)!, hash = digest(session);
      if (req.headers["x-kady-user"] && req.headers["x-kady-user"] !== user.id) throw new AccessError(401, "login_required", "Account changed; reload the workspace");
      let record = observers.get(hash);
      if (!record) { record = { userId: user.id, responses: new Set() }; observers.set(hash, record); }
      record.responses.add(reply.raw);
      const expiry = store.db.prepare("SELECT expires FROM sessions WHERE hash=?").get(hash) as { expires: number };
      const timer = setTimeout(() => reply.raw.destroy(), Math.max(1, expiry.expires - store.now())); timer.unref();
      const cleanup = () => { clearTimeout(timer); record!.responses.delete(reply.raw); if (!record!.responses.size) observers.delete(hash); };
      reply.raw.once("close", cleanup); reply.raw.once("finish", cleanup);
    }
  });
  app.addHook("onSend", async (req, reply) => {
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff").header("Referrer-Policy", "no-referrer");
  });
  app.get("/health", async () => ({ status: "ok", multiTenant: true }));
  app.get("/api/management/mode", async () => ({ multiTenant: true }));
  app.post("/api/management/login", async (req, reply) => {
    const body = payload(req), result = await store.login(body.username, body.password);
    reply.header("Set-Cookie", `${COOKIE}=${result.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure}`);
    return { user: result.user };
  });
  app.post("/api/management/join", async (req, reply) => {
    const user = await store.join(payload(req)); reply.code(201); return { user };
  });
  app.get("/api/management/me", async req => ({ user: identity(req) }));
  app.post("/api/management/logout", async (req, reply) => {
    const session = cookies(req).get(COOKIE);
    if (session) {
      store.logout(session);
      for (const response of observers.get(digest(session))?.responses ?? []) if (response !== reply.raw) response.destroy();
    }
    reply.header("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    return { ok: true };
  });
  app.get("/api/management/tenants", async req => ({ tenants: store.tenants(identity(req)).map(raw => { const t = raw as { id: string }; return { ...raw, usage: store.usage(t.id) }; }) }));
  app.post("/api/management/tenants", async (req, reply) => { reply.code(201); return store.createTenant(identity(req), payload(req)); });
  app.patch<{ Params: { id: string } }>("/api/management/tenants/:id", async req => {
    const tenant = store.patchTenant(identity(req), req.params.id, payload(req));
    if (!tenant.enabled) for (const user of store.db.prepare("SELECT id FROM users WHERE tenantId=?").all(tenant.id)) revokeObservers(String(user.id));
    return tenant;
  });
  app.post<{ Params: { id: string } }>("/api/management/tenants/:id/invites", async (req, reply) => { reply.code(201); return store.invite(identity(req), req.params.id, payload(req).role ?? "member"); });
  app.get<{ Params: { id: string } }>("/api/management/tenants/:id/members", async req => ({ members: store.members(identity(req), req.params.id) }));
  app.delete<{ Params: { id: string } }>("/api/management/users/:id", async req => { store.disableUser(identity(req), req.params.id); revokeObservers(req.params.id); return { ok: true }; });
  app.get("/api/management/platform", async req => {
    store.requireAdmin(identity(req)); return { configured: Boolean(store.setting("openrouterKey")), models: [...gateway.prices.keys()] };
  });
  app.put("/api/management/platform", async req => {
    store.requireAdmin(identity(req)); const raw = payload(req).apiKey;
    if (raw !== null && (typeof raw !== "string" || raw.length < 8 || raw.length > 4096 || /[\r\n\x00]/.test(raw))) throw new AccessError(400, "invalid_api_key");
    store.setSetting("openrouterKey", raw === null ? "" : raw as string); return { configured: Boolean(raw) };
  });
  app.get("/api/management/calls", async req => {
    const user = identity(req);
    return { calls: store.db.prepare(user.role === "admin" ? "SELECT * FROM model_calls ORDER BY created DESC LIMIT 200" : "SELECT * FROM model_calls WHERE tenantId=? ORDER BY created DESC LIMIT 200").all(...(user.role === "admin" ? [] : [user.tenantId!])) };
  });
  app.get("/api/management/usage", async req => {
    const user = identity(req);
    return { projects: store.db.prepare(`SELECT c.tenantId,c.projectId,COALESCE(json_extract(p.meta,'$.name'),'Retired project') name,COALESCE(SUM(c.cost),0) spentUsd,COALESCE(SUM(CASE WHEN c.state IN ('running','unsettled') THEN c.reserved ELSE 0 END),0) reservedUsd,SUM(CASE WHEN c.state='unsettled' THEN 1 ELSE 0 END) unsettled FROM model_calls c LEFT JOIN projects p ON p.id=c.projectId ${user.role === "admin" ? "" : "WHERE c.tenantId=?"} GROUP BY c.tenantId,c.projectId ORDER BY spentUsd DESC`).all(...(user.role === "admin" ? [] : [user.tenantId!])) };
  });
  app.post<{ Params: { id: string } }>("/api/management/calls/:id/reconcile", async req => { store.reconcile(identity(req), req.params.id, payload(req).costUsd); return { ok: true }; });
  app.post("/api/platform/v1/chat/completions", (req, reply) => gateway.handle(req, reply));
  app.post("/api/internal/tasks/acquire", async req => {
    const project = authenticateWorker(req);
    if (fleet.live.get(project.id)?.pending) throw new AccessError(409, "credentials_pending");
    return { lease: store.acquireTask(project, text(payload(req).key, "task key", 400)) };
  });
  app.post("/api/internal/tasks/release", async req => { store.releaseTask(authenticateWorker(req), text(payload(req).lease, "lease", 100)); return { ok: true }; });
  app.post("/api/internal/heartbeat", async req => {
    const project = authenticateWorker(req), live = fleet.live.get(project.id);
    if (!live || live.project.tokenHash !== project.tokenHash) throw new AccessError(409, "worker_replaced");
    return { ok: true };
  });
  app.get("/api/projects", async req => store.projects(identity(req)).map(meta));
  app.post("/api/projects", async (req, reply) => {
    const { project } = store.createProject(identity(req), payload(req));
    reply.code(201); return meta(project);
  });
  app.get("/api/projects/activity", async req => {
    const activities: Record<string, unknown> = {};
    for (const project of store.projects(identity(req))) {
      const worker = fleet.live.get(project.id);
      if (!worker) { activities[project.id] = { running: 0, needsInput: 0, errors: 0, blocked: 0, done: 0 }; continue; }
      try { const res = await fetch(`${worker.url}/projects/activity`, { headers: { "X-Kady-Token": worker.auth, "X-Project-Id": project.id }, signal: AbortSignal.timeout(5000) }); const body = await res.json() as { activities: Record<string, unknown> }; activities[project.id] = body.activities[project.id]; }
      catch { activities[project.id] = { running: 0, needsInput: 0, errors: 1, blocked: 0, done: 0 }; }
    }
    return { activities };
  });
  function selectProject(req: FastifyRequest, user: Identity): ManagedProject {
    const url = new URL(req.url, publicUrl);
    const fromPath = url.pathname.match(/^\/api\/projects\/([^/]+)/)?.[1];
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
    const selected = [fromPath ? decodeURIComponent(fromPath) : undefined, req.headers["x-project-id"], ...url.searchParams.getAll("project"), body.projectId, cookies(req).get("kady-project")].filter(x => x !== undefined && x !== "");
    if (selected.some(x => typeof x !== "string") || new Set(selected).size > 1) throw new AccessError(400, "conflicting_project");
    if (!selected.length) throw new AccessError(400, "project_required");
    return store.project(selected[0] as string, user);
  }
  app.get<{ Params: { id: string } }>("/api/projects/:id", async req => meta(selectProject(req, identity(req))));
  app.patch<{ Params: { id: string } }>("/api/projects/:id", async req => {
    const project = selectProject(req, identity(req)), body = payload(req);
    if (body.tenantId !== undefined && body.tenantId !== project.tenantId) throw new AccessError(403, "project_ownership_immutable");
    if (body.supply !== undefined) await fleet.changeSupply(project, body.supply);
    const worker = await fleet.ensure(store.project(project.id));
    const changes = { ...body }; delete changes.supply;
    if (Object.keys(changes).length) {
      const response = await fetch(`${worker.url}/projects/${project.id}`, { method: "PATCH", headers: { "X-Kady-Token": worker.auth, "X-Project-Id": project.id, "Content-Type": "application/json" }, body: JSON.stringify(changes) });
      if (!response.ok) throw new AccessError(response.status, "project_update_failed");
      store.db.prepare("UPDATE projects SET meta=? WHERE id=?").run(JSON.stringify(await response.json()), project.id);
    }
    return meta(store.project(project.id));
  });
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async req => {
    const project = selectProject(req, identity(req)), worker = await fleet.ensure(project);
    const state = await fleet.control(worker, "drain", "POST");
    if (state.busy || state.scheduled) { await fleet.control(worker, "resume", "POST"); throw new AccessError(409, "project_busy"); }
    await fleet.stop(project.id);
    store.db.prepare("DELETE FROM projects WHERE id=?").run(project.id);
    // Preserve the workspace on disk; deletion is retirement, not unrecorded data loss.
    return { ok: true };
  });
  app.all("/api/*", async (req, reply) => {
    const user = identity(req), project = selectProject(req, user);
    const url = new URL(req.url, publicUrl), route = url.pathname.slice(4);
    if (route.startsWith("/__managed/") || route.startsWith("/subagents/meter/")) throw new AccessError(403, "internal_only");
    if (route === "/openrouter/models" && project.supply === "platform" && req.method === "GET") {
      try { return await gateway.models(); }
      catch { throw new AccessError(502, "openrouter_models_unavailable", "Could not load models for the platform OpenRouter key. Ask the administrator to check credentials and retry."); }
    }
    if (route === "/credentials") {
      if (req.method !== "GET" && req.method !== "PUT") throw new AccessError(405, "method_not_allowed");
      const body = req.method === "PUT" ? payload(req) : undefined;
      if (project.supply === "platform" && body && Object.keys(body).some(key => !["exaApiKey", "perplexityApiKey", "geminiApiKey", "modalTokenId", "modalTokenSecret", "paperclipApiKey"].includes(key))) throw new AccessError(403, "platform_managed", "Platform model credentials are managed by the administrator");
      const status = await fleet.credentials(project.tenantId, body) as Record<string, { set: boolean; masked: string | null }>;
      if (project.supply === "platform") status.openrouter = { set: Boolean(store.setting("openrouterKey")), masked: store.setting("openrouterKey") ? "Platform managed" : null };
      return reply.send(status);
    }
    if (project.supply === "platform" && (route.startsWith("/model-auth/") || (route === "/custom-models" && req.method !== "GET"))) throw new AccessError(403, "platform_managed");
    const worker = await fleet.ensure(project);
    if (project.supply === "platform" && req.method === "POST" && startsManagedWork(route)) {
      const tenant = store.tenant(project.tenantId)!, usage = store.usage(project.tenantId);
      if (usage.unsettled) throw new AccessError(409, "usage_unsettled");
      if (tenant.budgetUsd !== null && usage.spentUsd + usage.reservedUsd >= tenant.budgetUsd) throw new AccessError(402, "platform_budget_exceeded");
    }
    if (project.supply === "platform" && req.method === "GET") {
      const configured = Boolean(store.setting("openrouterKey"));
      if (["/ollama/models", "/openai-compatible/models", "/nvidia/models"].includes(route)) return reply.send({ available: false, configured: false, models: [] });
      if (route === "/custom-models") return reply.send({ providers: [] });
      if (["/model-providers", "/model-providers/models", "/providers", "/providers/models"].includes(route)) {
        const response = await fetch(`${worker.url}${route}`, { headers: { "X-Kady-Token": worker.auth, "X-Project-Id": project.id }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new AccessError(response.status, "model_status_unavailable");
        const data = await response.json() as { providers?: { id: string; configured?: boolean; connected?: boolean }[]; models?: { id: string }[] };
        if (data.providers) data.providers = (route === "/providers" ? data.providers.filter(provider => provider.id === "openrouter") : data.providers).map(provider => ({ ...provider, configured: provider.id === "openrouter" && configured, connected: false, source: provider.id === "openrouter" ? "Platform" : null, apiKeyAlternative: false, loginLabel: null }));
        if (data.models) data.models = data.models.filter(model => configured && model.id.startsWith("openrouter/"));
        return reply.send(data);
      }
    }
    if (worker.pending && req.method !== "GET" && startsManagedWork(route)) throw new AccessError(409, "credentials_pending");
    await proxyRequest(req, reply, worker.url, `${route}${url.search}`, { "X-Kady-Token": worker.auth, "X-Project-Id": project.id, origin: publicUrl.origin });
  });
  if (options.uiUrl) {
    app.all("/*", async (req, reply) => {
      // Use one browser origin for cookies, API requests and the development WebSocket.
      if (req.headers.host?.toLowerCase() !== publicUrl.host) {
        if (!["GET", "HEAD"].includes(req.method)) throw new AccessError(403, "invalid_host");
        return reply.redirect(`${publicUrl.origin}${req.url.startsWith("/") ? req.url : "/"}`, 307);
      }
      return proxyRequest(req, reply, options.uiUrl!, req.url);
    });
    app.server.on("upgrade", (req, socket, head) => {
      if (!req.url?.startsWith("/_next/") || req.headers.origin !== publicUrl.origin) { socket.destroy(); return; }
      const target = new URL(req.url, options.uiUrl);
      if (target.origin !== new URL(options.uiUrl!).origin) { socket.destroy(); return; }
      const upstream = http.request(target, { headers: { ...req.headers, host: target.host } });
      upstream.on("upgrade", (response, peer, incoming) => {
        socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
        if (head.length) peer.write(head); if (incoming.length) socket.write(incoming);
        socket.pipe(peer); peer.pipe(socket);
        socket.on("error", () => peer.destroy()); peer.on("error", () => socket.destroy());
      });
      upstream.on("error", () => socket.destroy()); upstream.end();
    });
  }
  app.addHook("onClose", async () => {
    await fleet.close();
    if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, "utf8") === ownership) fs.rmSync(lockFile);
  });
  return app;
}

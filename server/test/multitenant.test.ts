import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { TenantStore, type Identity } from "../src/multitenant/store.ts";
import { buildManagementApp } from "../src/multitenant/server.ts";
import { ModelGateway } from "../src/multitenant/model-gateway.ts";

let root: string, store: TenantStore, app: FastifyInstance, admin: Identity, adminCookie: string;
const browser = { host: "localhost:3000", origin: "http://localhost:3000" };
const password = "correct-horse-battery-staple";
async function request(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, body?: unknown, cookie = adminCookie, headers: Record<string, string> = {}) {
  return app.inject({ method, url, headers: { ...browser, ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { payload: body }) });
}
async function login(username: string) {
  const result = await request("POST", "/api/management/login", { username, password }, "");
  expect(result.statusCode).toBe(200);
  return String(result.headers["set-cookie"]).split(";")[0];
}
async function tenantMember(name: string, role: "owner" | "member" = "owner") {
  const created = await request("POST", "/api/management/tenants", { name, budgetUsd: 0.7 });
  expect(created.statusCode).toBe(201);
  const tenant = created.json();
  const invited = await request("POST", `/api/management/tenants/${tenant.id}/invites`, { role });
  expect(invited.statusCode).toBe(201);
  const invite = invited.json();
  const joined = await request("POST", "/api/management/join", { token: invite.token, username: name, password }, "");
  expect(joined.statusCode).toBe(201);
  return { tenant, invite, user: joined.json().user as Identity, cookie: await login(name) };
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-tenants-"));
  store = new TenantStore(root);
  admin = await store.initializeAdmin("administrator", password);
  const gateway = new ModelGateway(store, new Map([["test/model", { input: 0.001, output: 0.001 }]]), "http://mock-provider.invalid/chat", async () => new Response(JSON.stringify({ choices: [], usage: { cost: 0.7, prompt_tokens: 5, completion_tokens: 1 } }), { headers: { "Content-Type": "application/json" } }));
  app = await buildManagementApp({ store, publicUrl: "http://localhost:3000", managerUrl: "http://127.0.0.1:8000", gateway });
  adminCookie = await login("administrator");
});
afterEach(async () => { await app.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });

describe("multi-tenant HTTP boundary", () => {
  it("recovers only an existing admin, revokes its sessions and preserves team access", async () => {
    const member = await tenantMember("alpha");
    const replacement = "synthetic-replacement-password";
    await expect(store.resetAdminPassword("alpha", replacement)).rejects.toThrow("admin_not_found");
    await expect(store.resetAdminPassword("missing-admin", replacement)).rejects.toThrow("admin_not_found");
    await expect(store.resetAdminPassword("administrator", "short")).rejects.toThrow("12–1024");
    expect((await request("GET", "/api/projects")).statusCode).toBe(200);
    await store.resetAdminPassword("ADMINISTRATOR", replacement);
    expect((await request("GET", "/api/projects")).statusCode).toBe(401);
    expect((await request("POST", "/api/management/login", { username: "administrator", password }, "")).statusCode).toBe(401);
    expect((await request("POST", "/api/management/login", { username: "administrator", password: replacement }, "")).statusCode).toBe(200);
    expect((await request("GET", "/api/projects", undefined, member.cookie)).statusCode).toBe(200);
  });
  it("uses the platform master key for the restricted catalogue without starting a credential-bearing worker", async () => {
    const member = await tenantMember("alpha");
    await request("PUT", "/api/management/platform", { apiKey: "synthetic-master-key" });
    const created = await request("POST", "/api/projects", { name: "Study", supply: "platform" }, member.cookie);
    vi.stubGlobal("fetch", vi.fn(async (url, options) => {
      expect(String(url)).toBe("https://openrouter.ai/api/v1/models/user");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer synthetic-master-key");
      return Response.json({ data: [{ id: "openai/gpt-5.5", pricing: { prompt: "0.000001", completion: "0.000002" } }] });
    }));
    // The production gateway is intentional here; only the upstream HTTP call is mocked.
    await app.close();
    app = await buildManagementApp({ store, publicUrl: "http://localhost:3000", managerUrl: "http://127.0.0.1:8000" });
    try {
      const response = await request("GET", "/api/openrouter/models", undefined, member.cookie, { "x-project-id": created.json().id });
      expect(response.statusCode).toBe(200);
      expect(response.json().models.map((model: { id: string }) => model.id)).toEqual(["openrouter/openai/gpt-5.5"]);
      expect(response.body).not.toContain("synthetic-master-key");
    } finally { vi.unstubAllGlobals(); }
  });
  it("expires invitations and consumes an invitation atomically under concurrent joins", async () => {
    const owner = await tenantMember("alpha");
    const expired = await request("POST", `/api/management/tenants/${owner.tenant.id}/invites`, { role: "member" });
    const now = store.now();
    const clock = vi.spyOn(store, "now").mockReturnValue(now + 2 * 86400000);
    expect((await request("POST", "/api/management/join", { token: expired.json().token, username: "late-user", password }, "")).statusCode).toBe(400);
    clock.mockRestore();
    const fresh = await request("POST", `/api/management/tenants/${owner.tenant.id}/invites`, { role: "member" });
    const joins = await Promise.all(["first-user", "second-user"].map(username => request("POST", "/api/management/join", { token: fresh.json().token, username, password }, "")));
    expect(joins.map(result => result.statusCode).sort()).toEqual([201, 400]);
  });
  it("uses one-time invitations and validates owner/member management privileges", async () => {
    const owner = await tenantMember("alpha");
    const reuse = await request("POST", "/api/management/join", { token: owner.invite.token, username: "another", password }, "");
    expect(reuse.statusCode).toBe(400);
    const invite = await request("POST", `/api/management/tenants/${owner.tenant.id}/invites`, { role: "member" }, owner.cookie);
    const member = await request("POST", "/api/management/join", { token: invite.json().token, username: "researcher", password }, "");
    expect(member.statusCode).toBe(201);
    const cookie = await login("researcher");
    expect((await request("POST", `/api/management/tenants/${owner.tenant.id}/invites`, {}, cookie)).statusCode).toBe(403);
    expect((await request("PATCH", `/api/management/tenants/${owner.tenant.id}`, { budgetUsd: 100 }, cookie)).statusCode).toBe(403);
    expect((await request("PUT", "/api/management/platform", { apiKey: "platform-secret-key" }, cookie)).statusCode).toBe(403);
  });
  it("does not list or expose foreign projects, nor fall back for unknown ids", async () => {
    const a = await tenantMember("alpha"), b = await tenantMember("bravo");
    const created = await request("POST", "/api/projects", { name: "Study" }, a.cookie);
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect((await request("GET", "/api/projects", undefined, b.cookie)).json()).toEqual([]);
    expect((await request("GET", `/api/projects/${project.id}`, undefined, b.cookie)).statusCode).toBe(404);
    expect((await request("GET", "/api/sandbox/tree", undefined, b.cookie, { "x-project-id": project.id })).statusCode).toBe(404);
    expect((await request("GET", "/api/sandbox/raw?project=missing&path=a.csv", undefined, a.cookie)).statusCode).toBe(404);
    expect((await request("GET", `/api/projects/${project.id}?project=other`, undefined, a.cookie, { "x-project-id": project.id })).statusCode).toBe(400);
    expect((await request("POST", "/api/projects", { name: "Foreign", tenantId: b.tenant.id }, a.cookie)).statusCode).toBe(403);
  });
  it("revokes sessions on logout and member removal, rejects cross-origin mutation", async () => {
    const owner = await tenantMember("alpha");
    expect((await request("GET", "/api/projects", undefined, "")).statusCode).toBe(401);
    expect((await request("POST", "/api/projects", { name: "CSRF" }, owner.cookie, { origin: "https://attacker.invalid" })).statusCode).toBe(403);
    const old = owner.cookie;
    expect((await request("POST", "/api/management/logout", {}, old)).statusCode).toBe(200);
    expect((await request("GET", "/api/projects", undefined, old)).statusCode).toBe(401);
    const member = await tenantMember("bravo", "member");
    expect((await request("DELETE", `/api/management/users/${member.user.id}`)).statusCode).toBe(200);
    expect((await request("GET", "/api/projects", undefined, member.cookie)).statusCode).toBe(401);
  });
  it("rejects foreign resources through every project selector and rejects retired projects", async () => {
    const a = await tenantMember("alpha"), b = await tenantMember("bravo");
    const project = (await request("POST", "/api/projects", { name: "Study" }, a.cookie)).json();
    for (const [method, route] of [
      ["GET", "/sandbox/download?path=report.docx"], ["GET", "/sandbox/office?path=report.docx"],
      ["GET", "/sessions/foreign/history"], ["POST", "/sessions/foreign/abort"],
      ["POST", "/model-auth/flows"], ["PATCH", `/projects/${project.id}`], ["DELETE", `/projects/${project.id}`],
    ] as const) expect((await request(method, `/api${route}`, method === "GET" ? undefined : {}, b.cookie, { "x-project-id": project.id })).statusCode).toBe(404);
    const selectors: Record<string, string>[] = [{ "x-project-id": project.id }, { cookie: `${b.cookie}; kady-project=${project.id}` }];
    for (const headers of selectors)
      expect((await request("GET", "/api/sandbox/tree", undefined, b.cookie, headers)).statusCode).toBe(404);
    expect((await request("GET", `/api/sandbox/tree?project=${project.id}`, undefined, b.cookie)).statusCode).toBe(404);
    expect((await request("POST", "/api/sessions/foreign/run", { projectId: project.id }, b.cookie)).statusCode).toBe(404);
    expect((await request("POST", "/api/sessions/foreign/run", { projectId: "conflicting" }, a.cookie, { "x-project-id": project.id })).statusCode).toBe(400);
    expect((await request("GET", `/api/sandbox/tree?project=${project.id}&project=conflicting`, undefined, a.cookie)).statusCode).toBe(400);
    expect((await request("GET", `/api/management/tenants/${a.tenant.id}/members`, undefined, b.cookie)).statusCode).toBe(403);
    store.db.prepare("DELETE FROM projects WHERE id=?").run(project.id);
    expect((await request("GET", `/api/projects/${project.id}`, undefined, a.cookie)).statusCode).toBe(404);
  });
  it("expires sessions and immediately revokes disabled accounts", async () => {
    const owner = await tenantMember("alpha", "member");
    const clock = vi.spyOn(store, "now").mockReturnValue(store.now() + 8 * 86400000);
    expect((await request("GET", "/api/projects", undefined, owner.cookie)).statusCode).toBe(401);
    clock.mockRestore();
    expect((await request("DELETE", `/api/management/users/${owner.user.id}`)).statusCode).toBe(200);
    expect((await request("GET", "/api/projects", undefined, owner.cookie)).statusCode).toBe(401);
    expect((await request("POST", "/api/management/login", { username: "alpha", password }, "")).statusCode).toBe(401);
  });
  it("enforces platform budgets across projects, isolates BYOK and preserves usage on restart", async () => {
    const member = await tenantMember("alpha");
    await request("PUT", "/api/management/platform", { apiKey: "platform-secret-key" });
    const a = store.createProject(member.user, { name: "First", supply: "platform" });
    const b = store.createProject(member.user, { name: "Second", supply: "platform" });
    const byok = store.createProject(member.user, { name: "BYOK" });
    const modelCall = (key: string) => app.inject({ method: "POST", url: "/api/platform/v1/chat/completions", headers: { authorization: `Bearer ${key}` }, payload: { model: "test/model", messages: [{ role: "user", content: "Hi" }], max_tokens: 5 } });
    expect((await modelCall(a.token)).statusCode).toBe(200);
    expect((await modelCall(b.token)).statusCode).toBe(402);
    expect((await modelCall(byok.token)).statusCode).toBe(403);
    expect(store.usage(member.tenant.id).spentUsd).toBe(0.7);
    const totals = await request("GET", "/api/management/usage", undefined, member.cookie);
    expect(totals.json().projects).toContainEqual(expect.objectContaining({ projectId: a.project.id, tenantId: member.tenant.id, spentUsd: 0.7 }));
    await app.close(); store.close();
    store = new TenantStore(root);
    app = await buildManagementApp({ store, publicUrl: "http://localhost:3000", managerUrl: "http://127.0.0.1:8000", gateway: new ModelGateway(store, new Map()) });
    expect(store.usage(member.tenant.id).spentUsd).toBe(0.7);
    expect((await request("GET", "/api/projects", undefined, member.cookie)).statusCode).toBe(200);
    const status = (await request("GET", "/api/management/platform")).json();
    expect(status.configured).toBe(true); expect(JSON.stringify(status)).not.toContain("platform-secret-key");
  });
  it("counts reservations atomically and does not treat unresolved usage as free", async () => {
    const member = await tenantMember("alpha");
    await request("PATCH", `/api/management/tenants/${member.tenant.id}`, { modelLimit: 1 });
    const { project } = store.createProject(member.user, { name: "Study", supply: "platform" });
    const first = store.admitModel(project, "test/model", 0.1);
    expect(() => store.admitModel(project, "test/model", 0.1)).toThrow("model_concurrency_exceeded");
    store.settle(first, null);
    expect(() => store.admitModel(project, "test/model", 0.1)).toThrow("administrator must reconcile");
    expect((await request("POST", `/api/management/calls/${first}/reconcile`, { costUsd: 0.2 }, member.cookie)).statusCode).toBe(403);
    expect((await request("POST", `/api/management/calls/${first}/reconcile`, { costUsd: 0.2 })).statusCode).toBe(200);
    store.settle(first, 999);
    expect(store.usage(member.tenant.id).spentUsd).toBe(0.2);
    const next = store.admitModel(project, "test/model", 0.1);
    store.settle(next, 0);
    expect(store.usage(member.tenant.id).running).toBe(0);
  });
  it("applies the five-task deployment cap across tenants and releases only the owning project's lease", async () => {
    const a = await tenantMember("alpha"), b = await tenantMember("bravo");
    const first = store.createProject(a.user, { name: "First" }), second = store.createProject(b.user, { name: "Second" });
    const acquire = (key: string, task: string) => app.inject({ method: "POST", url: "/api/internal/tasks/acquire", headers: { authorization: `Bearer ${key}` }, payload: { key: task } });
    const leases = await Promise.all(Array.from({ length: 5 }, (_, i) => acquire(first.token, `task-${i}`)));
    expect(leases.every(result => result.statusCode === 200)).toBe(true);
    expect((await acquire(second.token, "sixth")).statusCode).toBe(429);
    const release = (key: string) => app.inject({ method: "POST", url: "/api/internal/tasks/release", headers: { authorization: `Bearer ${key}` }, payload: { lease: leases[0].json().lease } });
    await release(second.token);
    expect((await acquire(second.token, "sixth")).statusCode).toBe(429);
    await release(first.token);
    expect((await acquire(second.token, "sixth")).statusCode).toBe(200);
  });
});

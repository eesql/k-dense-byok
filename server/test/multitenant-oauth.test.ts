import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ProviderAuthManager } from "../src/agent/provider-auth.ts";
import { registerModelProviderRoutes } from "../src/api/model-providers.ts";
import { TenantStore } from "../src/multitenant/store.ts";
import { WorkerFleet } from "../src/multitenant/workers.ts";
import { buildManagementApp } from "../src/multitenant/server.ts";

it("mediates real Pi manual OAuth through the owned project, keeps foreign flows inaccessible, and reopens the shared login", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-managed-oauth-"));
  const store = new TenantStore(root), admin = await store.initializeAdmin("administrator", "synthetic-admin-password");
  const a = store.createTenant(admin, { name: "A" }), b = store.createTenant(admin, { name: "B" });
  const user = await store.join({ token: store.invite(admin, a.id, "owner").token, username: "researcher", password: "synthetic-admin-password" });
  const own = store.createProject(user, { name: "Own" }).project, foreign = store.createProject(admin, { tenantId: b.id, name: "Foreign" }).project;
  const authPath = path.join(root, "tenants", a.id, "pi-agent", "auth.json");
  const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
  const manager = new ProviderAuthManager(runtime), worker = Fastify();
  await registerModelProviderRoutes(worker, { runtime, manager });
  const workerUrl = await worker.listen({ port: 0, host: "127.0.0.1" });
  const fleet = new WorkerFleet(store, "http://127.0.0.1:0", "http://localhost:3000");
  vi.spyOn(fleet, "ensure").mockImplementation(async project => ({ project, auth: "fixture-worker-token", pending: false, url: workerUrl, child: {} as ChildProcess }));
  const app = await buildManagementApp({ store, publicUrl: fleet.publicUrl, managerUrl: fleet.managerUrl, fleet });
  const session = await store.login("researcher", "synthetic-admin-password");
  const headers = { host: "localhost:3000", origin: "http://localhost:3000", cookie: `kady_session=${session.token}`, "X-Project-Id": own.id };
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    if (String(url) !== "https://openrouter.ai/api/v1/auth/keys") throw new Error("Unexpected external request");
    expect(JSON.parse(String(options?.body)).code).toBe("test-code");
    return Response.json({ key: "synthetic-oauth-key" });
  }));
  try {
    const started = await app.inject({ method: "POST", url: "/api/model-auth/flows", headers, payload: { providerId: "openrouter" } });
    expect(started.statusCode).toBe(202);
    const flowId = started.json().id;
    await vi.waitFor(() => expect(manager.get(flowId).prompt?.type).toBe("manual_code"));
    expect((await app.inject({ method: "GET", url: `/api/model-auth/flows/${flowId}`, headers: { ...headers, "X-Project-Id": foreign.id } })).statusCode).toBe(404);
    const flow = manager.get(flowId), event = flow.events.find(e => e.type === "auth_url");
    if (event?.type !== "auth_url") throw new Error("Missing provider URL");
    const redirect = new URL(new URL(event.url).searchParams.get("callback_url")!); redirect.searchParams.set("code", "test-code");
    const responded = await app.inject({ method: "POST", url: `/api/model-auth/flows/${flowId}/respond`, headers, payload: { promptId: flow.prompt!.id, value: redirect.toString() } });
    expect(responded.statusCode).toBe(200);
    await vi.waitFor(() => expect(manager.get(flowId).status).toBe("complete"));
    const complete = await app.inject({ method: "GET", url: `/api/model-auth/flows/${flowId}`, headers });
    expect(complete.body).not.toContain("synthetic-oauth-key");
    const reopened = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
    expect(await reopened.checkAuth("openrouter")).toMatchObject({ type: "oauth" });
    expect((await reopened.getAuth("openrouter"))?.auth.apiKey).toBe("synthetic-oauth-key");
    expect(fs.existsSync(path.join(root, "tenants", b.id, "pi-agent", "auth.json"))).toBe(false);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); await app.close(); await worker.close(); manager.dispose(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 20000);

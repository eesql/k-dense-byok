import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { TenantStore } from "../src/multitenant/store.ts";
import { WorkerFleet } from "../src/multitenant/workers.ts";
import { buildManagementApp } from "../src/multitenant/server.ts";
import { multiTenantEnabled } from "../../multi-tenancy-mode.mjs";

it("defaults off and rejects invalid deployment modes", () => {
  expect(multiTenantEnabled("")).toBe(false);
  expect(multiTenantEnabled("off")).toBe(false);
  expect(multiTenantEnabled("1")).toBe(true);
  expect(() => multiTenantEnabled("enabled-ish")).toThrow();
});

it("runs real project workers with fixed scope and separate BYOK/platform snapshots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-worker-integration-"));
  const store = new TenantStore(root), admin = await store.initializeAdmin("administrator", "test-password-for-setup");
  const tenant = store.createTenant(admin, { name: "Lab" });
  const invite = store.invite(admin, tenant.id, "owner");
  const user = await store.join({ token: invite.token, username: "researcher", password: "test-password-for-setup" });
  const a = store.createProject(user, { name: "Own model", supply: "byok" }).project;
  const b = store.createProject(user, { name: "Platform", supply: "platform" }).project;
  const fleet = new WorkerFleet(store, "http://127.0.0.1:0", "http://localhost:3000");
  fs.mkdirSync(path.dirname(fleet.tenantEnv(tenant.id)), { recursive: true });
  fs.writeFileSync(fleet.tenantEnv(tenant.id), "OPENROUTER_API_KEY=byok-integration-key\n");
  const app = await buildManagementApp({ store, publicUrl: "http://localhost:3000", managerUrl: fleet.managerUrl, fleet });
  fleet.managerUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const [own, platform] = await Promise.all([fleet.ensure(a), fleet.ensure(b)]);
    const get = async (worker: typeof own, route: string, project = worker.project.id) => fetch(`${worker.url}${route}`, { headers: { "X-Kady-Token": worker.auth, "X-Project-Id": project } });
    const ownKeys = await (await get(own, "/credentials")).json();
    const platformKeys = await (await get(platform, "/credentials")).json();
    expect(JSON.stringify(ownKeys)).toContain("byok");
    expect(JSON.stringify(platformKeys)).not.toContain("byok");
    expect((await get(own, "/sandbox/tree", b.id)).status).toBe(404);
    const projects = await (await get(own, "/projects")).json() as { id: string }[];
    expect(projects.map(p => p.id)).toEqual([a.id]);
    expect(await fleet.control(own, "state")).toMatchObject({ busy: false, scheduled: false });
    const login = await store.login("researcher", "test-password-for-setup");
    const headers = { cookie: `kady_session=${login.token}`, host: "localhost:3000", origin: "http://localhost:3000", "X-Project-Id": a.id };
    const multipart = "--fixture-boundary\r\nContent-Disposition: form-data; name=\"files\"; filename=\"uploaded.txt\"\r\nContent-Type: text/plain\r\n\r\nuploaded through managed stream\r\n--fixture-boundary--\r\n";
    const uploaded = await app.inject({ method: "POST", url: "/api/sandbox/upload", headers: { ...headers, "Content-Type": "multipart/form-data; boundary=fixture-boundary" }, payload: multipart });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const downloaded = await app.inject({ method: "GET", url: "/api/sandbox/download?path=user_data/uploaded.txt", headers });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.body).toBe("uploaded through managed stream");
    const binary = fs.readFileSync(path.join(import.meta.dirname, "fixtures/office/report.docx"));
    const officeFile = path.join(fleet.root(a), "projects", a.id, "sandbox", "report.docx");
    fs.writeFileSync(officeFile, binary);
    const snapshot = await app.inject({ method: "GET", url: "/api/sandbox/office/content?path=report.docx", headers });
    expect(snapshot.statusCode).toBe(200); expect(snapshot.rawPayload).toEqual(binary);
    const preview = await app.inject({ method: "GET", url: "/api/sandbox/office?path=report.docx", headers });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json().groups.length).toBeGreaterThan(0);
    const saved = await app.inject({ method: "PUT", url: "/api/sandbox/office/content?path=report.docx", headers: { ...headers, "Content-Type": "application/octet-stream", "If-Match": String(snapshot.headers["x-content-sha256"]) }, payload: binary });
    expect(saved.statusCode, saved.body).toBe(200);
    const stale = await app.inject({ method: "PUT", url: "/api/sandbox/office/content?path=report.docx", headers: { ...headers, "Content-Type": "application/octet-stream", "If-Match": "0".repeat(64) }, payload: binary });
    expect(stale.statusCode).toBe(409);
    const c = (await app.inject({ method: "POST", url: "/api/projects", headers: { cookie: headers.cookie, host: headers.host, origin: headers.origin }, payload: { name: "Concurrent startup" } })).json();
    const [updated, opened] = await Promise.all([
      app.inject({ method: "PUT", url: "/api/credentials", headers, payload: { openrouterApiKey: "updated-integration-key" } }),
      app.inject({ method: "GET", url: "/api/sandbox/tree", headers: { ...headers, "X-Project-Id": c.id } }),
    ]);
    expect(updated.statusCode, updated.body).toBe(200);
    expect(opened.statusCode, opened.body).toBe(200);
    const concurrent = await fleet.ensure(store.project(c.id));
    expect(JSON.stringify(await (await get(concurrent, "/credentials")).json())).toContain("upda");
    const data = path.join(fleet.root(a), "projects", a.id, "sandbox", "keep.txt");
    fs.writeFileSync(data, "keep history and artifacts");
    const changed = await app.inject({ method: "PATCH", url: `/api/projects/${a.id}`, headers, payload: { supply: "platform" } });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(store.project(a.id).supply).toBe("platform");
    expect(fs.readFileSync(data, "utf8")).toBe("keep history and artifacts");
    expect(fs.existsSync(path.join(root, ".env"))).toBe(false);
    const metaFile = path.join(fleet.root(a), "projects", a.id, "project.json"), savedMeta = fs.readFileSync(metaFile);
    fs.writeFileSync(metaFile, "invalid project metadata");
    const failed = await app.inject({ method: "PATCH", url: `/api/projects/${a.id}`, headers, payload: { supply: "byok" } });
    expect(failed.statusCode).toBe(500);
    expect((await app.inject({ method: "GET", url: `/api/projects/${a.id}`, headers })).json().supply).toBe("byok");
    expect((await app.inject({ method: "GET", url: "/api/sandbox/tree", headers })).statusCode).toBe(500);
    fs.writeFileSync(metaFile, savedMeta);
    expect((await app.inject({ method: "GET", url: "/api/sandbox/download?path=keep.txt", headers })).body).toBe("keep history and artifacts");
  } catch (error) {
    const file = path.join(fleet.root(a), "worker.log");
    const diagnostic = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replaceAll("byok-integration-key", "[test key]") : "no worker diagnostics";
    throw new Error(`${(error as Error).message}\n${diagnostic}`);
  } finally { await app.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 90000);

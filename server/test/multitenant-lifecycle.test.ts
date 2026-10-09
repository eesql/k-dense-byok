import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { TenantStore } from "../src/multitenant/store.ts";
import { buildManagementApp } from "../src/multitenant/server.ts";

it("redirects page visits to the configured LAN origin while preserving API origin checks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-public-origin-"));
  const store = new TenantStore(root);
  const app = await buildManagementApp({ store, publicUrl: "https://kady.lab.example", managerUrl: "http://127.0.0.1:3000", uiUrl: "http://127.0.0.1:1" });
  try {
    const page = await app.inject({ method: "GET", url: "/?project=study", headers: { host: "127.0.0.1:3000" } });
    expect(page.statusCode).toBe(307);
    expect(page.headers.location).toBe("https://kady.lab.example/?project=study");
    const login = await app.inject({ method: "POST", url: "/api/management/login", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }, payload: { username: "synthetic", password: "synthetic-password" } });
    expect(login.statusCode).toBe(403);
    const me = await app.inject({ method: "GET", url: "/api/management/me", headers: { host: "kady.lab.example", origin: "https://kady.lab.example" } });
    expect(me.statusCode).toBe(401);
    expect(me.json().reason).toBe("login_required");
  } finally { await app.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("refuses disabled and malformed managed startup without creating state or a fallback listener", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-mode-startup-"));
  try {
    for (const mode of ["0", "invalid-mode"]) {
      const state = path.join(root, mode);
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/multitenant/main.ts"], { cwd: path.resolve(import.meta.dirname, ".."), env: { PATH: process.env.PATH, KADY_MULTI_TENANT: mode, KADY_MT_ROOT: state }, encoding: "utf8", timeout: 15000 });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/not enabled|KADY_MULTI_TENANT/);
      expect(fs.existsSync(state)).toBe(false);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it("keeps a live manager's commitments intact and recovers only after the owning manager closes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-recovery-"));
  const store = new TenantStore(root), admin = await store.initializeAdmin("administrator", "synthetic-admin-password");
  const tenant = store.createTenant(admin, { name: "Lab" }), project = store.createProject(admin, { tenantId: tenant.id, name: "Project", supply: "platform" }).project;
  const app = await buildManagementApp({ store, publicUrl: "http://localhost:3000", managerUrl: "http://127.0.0.1:8000" });
  const call = store.admitModel(project, "test", 0.5), lease = store.acquireTask(project, "ongoing");
  const inspector = new TenantStore(root);
  try {
    expect(inspector.usage(tenant.id).running).toBe(1);
    expect(inspector.db.prepare("SELECT id FROM task_leases WHERE id=?").get(lease)).toBeDefined();
    await expect(buildManagementApp({ store: inspector, publicUrl: "http://localhost:3001", managerUrl: "http://127.0.0.1:8001" })).rejects.toThrow("manager_already_running");
    expect(store.usage(tenant.id).running).toBe(1);
  } finally { inspector.close(); await app.close(); store.close(); }
  const recovered = new TenantStore(root);
  const reopened = await buildManagementApp({ store: recovered, publicUrl: "http://localhost:3000", managerUrl: "http://127.0.0.1:8000" });
  try {
    expect(recovered.usage(tenant.id)).toMatchObject({ running: 0, unsettled: 1, reservedUsd: 0.5 });
    expect(recovered.db.prepare("SELECT id FROM model_calls WHERE id=?").get(call)).toBeDefined();
    expect(recovered.db.prepare("SELECT COUNT(*) n FROM task_leases").get()).toMatchObject({ n: 0 });
    expect(recovered.project(project.id).tenantId).toBe(tenant.id);
  } finally { await reopened.close(); recovered.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

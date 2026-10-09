import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Role = "admin" | "owner" | "member";
export type Supply = "byok" | "platform";
export interface Identity { id: string; username: string; role: Role; tenantId: string | null }
export interface Tenant { id: string; name: string; enabled: number; budgetUsd: number | null; taskLimit: number; modelLimit: number }
export interface ManagedProject { id: string; tenantId: string; supply: Supply; meta: string; tokenHash: string }
export class AccessError extends Error {
  constructor(public status: number, public reason: string, message = reason) { super(message); }
}
export const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const token = () => crypto.randomBytes(32).toString("base64url");
const id = () => crypto.randomUUID();

export function text(value: unknown, name: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new AccessError(400, "invalid_input", `Invalid ${name}`);
  return value.trim();
}
export function limit(value: unknown, name: string, max = 100): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) throw new AccessError(400, "invalid_input", `Invalid ${name}`);
  return value as number;
}
export function budget(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e9) throw new AccessError(400, "invalid_input", "Invalid budget");
  return value;
}
export async function passwordHash(password: unknown): Promise<string> {
  if (typeof password !== "string" || password.length < 12 || password.length > 1024) throw new AccessError(400, "invalid_password", "Use a password of 12–1024 characters");
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64, (err, result) => err ? reject(err) : resolve(result)));
  return `${salt}:${key.toString("hex")}`;
}
async function passwordMatches(password: string, hash: string): Promise<boolean> {
  const [salt, encoded] = hash.split(":");
  const key = await new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, 64, (err, result) => err ? reject(err) : resolve(result)));
  const expected = Buffer.from(encoded, "hex");
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

export class TenantStore {
  readonly db: DatabaseSync;
  constructor(readonly root: string, readonly now = () => Date.now()) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, "management.sqlite"));
    this.db.exec(`
      PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, budgetUsd REAL, taskLimit INTEGER NOT NULL, modelLimit INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','owner','member')), tenantId TEXT REFERENCES tenants(id), enabled INTEGER NOT NULL DEFAULT 1, CHECK((role='admin' AND tenantId IS NULL) OR (role!='admin' AND tenantId IS NOT NULL)));
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY, tenantId TEXT NOT NULL REFERENCES tenants(id), role TEXT NOT NULL CHECK(role IN ('owner','member')), expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, tenantId TEXT NOT NULL REFERENCES tenants(id), supply TEXT NOT NULL CHECK(supply IN ('byok','platform')), meta TEXT NOT NULL, tokenHash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS model_calls(id TEXT PRIMARY KEY, tenantId TEXT NOT NULL REFERENCES tenants(id), projectId TEXT NOT NULL, state TEXT NOT NULL, reserved REAL NOT NULL, cost REAL, created INTEGER NOT NULL, model TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_leases(id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), tenantId TEXT NOT NULL REFERENCES tenants(id), leaseKey TEXT NOT NULL, UNIQUE(projectId,leaseKey));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    fs.chmodSync(path.join(root, "management.sqlite"), 0o600);
    // ponytail: one manager owns the database; restart retains uncertain paid calls, releases dead process leases.
  }
  close() { this.db.close(); }
  recover() { this.db.exec("UPDATE model_calls SET state='unsettled' WHERE state='running'; DELETE FROM task_leases;"); }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  username(value: unknown) {
    const name = text(value, "username", 80).toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(name)) throw new AccessError(400, "invalid_username");
    return name;
  }
  async initializeAdmin(username: unknown, password: unknown): Promise<Identity> {
    const name = this.username(username), hash = await passwordHash(password);
    return this.transaction(() => {
      if (this.db.prepare("SELECT id FROM users WHERE role='admin'").get()) throw new AccessError(409, "already_initialized");
      const userId = id();
      this.db.prepare("INSERT INTO users(id,username,password,role) VALUES(?,?,?,'admin')").run(userId, name, hash);
      return { id: userId, username: name, role: "admin", tenantId: null };
    });
  }
  async login(username: unknown, password: unknown): Promise<{ token: string; user: Identity }> {
    const name = this.username(username);
    if (typeof password !== "string" || password.length > 1024) throw new AccessError(401, "invalid_login");
    const user = this.db.prepare("SELECT * FROM users WHERE username=? AND enabled=1").get(name) as (Identity & { password: string }) | undefined;
    // Hash even a missing user to avoid a cheap account-existence timing signal.
    const valid = await passwordMatches(password, user?.password ?? `${"0".repeat(32)}:${"0".repeat(128)}`);
    if (!user || !valid || (user.tenantId && !this.tenant(user.tenantId)?.enabled)) throw new AccessError(401, "invalid_login", "Incorrect username or password");
    const session = token();
    this.db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(digest(session), user.id, this.now() + 7 * 86400000);
    return { token: session, user: this.identity(user) };
  }
  identity(user: Identity): Identity { return { id: user.id, username: user.username, role: user.role, tenantId: user.tenantId }; }
  authenticate(session: string | undefined): Identity {
    const user = session && this.db.prepare("SELECT u.* FROM sessions s JOIN users u ON u.id=s.userId LEFT JOIN tenants t ON t.id=u.tenantId WHERE s.hash=? AND s.expires>? AND u.enabled=1 AND (u.role='admin' OR t.enabled=1)").get(digest(session), this.now()) as Identity | undefined;
    if (!user) throw new AccessError(401, "login_required");
    return this.identity(user);
  }
  logout(session: string) { this.db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(session)); }
  requireAdmin(user: Identity) { if (user.role !== "admin") throw new AccessError(403, "admin_required"); }
  requireOwner(user: Identity, tenantId: string) {
    if (user.role !== "admin" && (user.role !== "owner" || user.tenantId !== tenantId)) throw new AccessError(403, "owner_required");
  }
  tenant(tenantId: string): Tenant | undefined { return this.db.prepare("SELECT * FROM tenants WHERE id=?").get(tenantId) as unknown as Tenant | undefined; }
  tenants(user: Identity) {
    return user.role === "admin" ? this.db.prepare("SELECT * FROM tenants ORDER BY name").all() : this.db.prepare("SELECT * FROM tenants WHERE id=?").all(user.tenantId!);
  }
  createTenant(user: Identity, raw: Record<string, unknown>): Tenant {
    this.requireAdmin(user);
    const tenant: Tenant = { id: id(), name: text(raw.name, "tenant name"), enabled: 1, budgetUsd: budget(raw.budgetUsd ?? null), taskLimit: limit(raw.taskLimit ?? 5, "task limit"), modelLimit: limit(raw.modelLimit ?? 5, "model limit") };
    this.db.prepare("INSERT INTO tenants VALUES(?,?,?,?,?,?)").run(tenant.id, tenant.name, 1, tenant.budgetUsd, tenant.taskLimit, tenant.modelLimit);
    return tenant;
  }
  patchTenant(user: Identity, tenantId: string, raw: Record<string, unknown>): Tenant {
    this.requireAdmin(user);
    const old = this.tenant(tenantId);
    if (!old) throw new AccessError(404, "tenant_not_found");
    const next = { ...old, name: raw.name === undefined ? old.name : text(raw.name, "name"), budgetUsd: raw.budgetUsd === undefined ? old.budgetUsd : budget(raw.budgetUsd), taskLimit: raw.taskLimit === undefined ? old.taskLimit : limit(raw.taskLimit, "task limit"), modelLimit: raw.modelLimit === undefined ? old.modelLimit : limit(raw.modelLimit, "model limit"), enabled: raw.enabled === undefined ? old.enabled : raw.enabled === true ? 1 : raw.enabled === false ? 0 : (() => { throw new AccessError(400, "invalid_input"); })() };
    this.db.prepare("UPDATE tenants SET name=?,budgetUsd=?,taskLimit=?,modelLimit=?,enabled=? WHERE id=?").run(next.name, next.budgetUsd, next.taskLimit, next.modelLimit, next.enabled, tenantId);
    return next;
  }
  invite(user: Identity, tenantId: string, role: unknown = "member") {
    this.requireOwner(user, tenantId);
    if (!this.tenant(tenantId)?.enabled) throw new AccessError(404, "tenant_not_found");
    if (role !== "member" && role !== "owner") throw new AccessError(400, "invalid_role");
    const invitation = token(), expires = this.now() + 86400000;
    this.db.prepare("INSERT INTO invites VALUES(?,?,?,?,0)").run(digest(invitation), tenantId, role, expires);
    return { token: invitation, expires };
  }
  async join(raw: Record<string, unknown>): Promise<Identity> {
    const invitation = text(raw.token, "invitation", 128), username = this.username(raw.username), password = await passwordHash(raw.password);
    return this.transaction(() => {
      const invite = this.db.prepare("SELECT i.* FROM invites i JOIN tenants t ON t.id=i.tenantId WHERE i.hash=? AND i.used=0 AND i.expires>? AND t.enabled=1").get(digest(invitation), this.now()) as { tenantId: string; role: Role } | undefined;
      if (!invite) throw new AccessError(400, "invalid_invitation");
      if (this.db.prepare("SELECT id FROM users WHERE username=?").get(username)) throw new AccessError(409, "username_taken");
      const user: Identity = { id: id(), username, role: invite.role, tenantId: invite.tenantId };
      this.db.prepare("INSERT INTO users(id,username,password,role,tenantId) VALUES(?,?,?,?,?)").run(user.id, username, password, user.role, user.tenantId);
      this.db.prepare("UPDATE invites SET used=1 WHERE hash=?").run(digest(invitation));
      return user;
    });
  }
  members(user: Identity, tenantId: string) {
    this.requireOwner(user, tenantId);
    return this.db.prepare("SELECT id,username,role,tenantId,enabled FROM users WHERE tenantId=? ORDER BY username").all(tenantId);
  }
  disableUser(actor: Identity, userId: string) {
    const user = this.db.prepare("SELECT * FROM users WHERE id=?").get(userId) as Identity | undefined;
    if (!user) throw new AccessError(404, "user_not_found");
    if (user.role === "admin") this.requireAdmin(actor); else this.requireOwner(actor, user.tenantId!);
    if (user.id === actor.id || (user.role === "owner" && !this.db.prepare("SELECT id FROM users WHERE tenantId=? AND role='owner' AND enabled=1 AND id!=?").get(user.tenantId!, user.id))) throw new AccessError(409, "last_owner_or_self");
    this.transaction(() => { this.db.prepare("UPDATE users SET enabled=0 WHERE id=?").run(userId); this.db.prepare("DELETE FROM sessions WHERE userId=?").run(userId); });
  }
  projects(user: Identity) { return this.db.prepare(user.role === "admin" ? "SELECT * FROM projects WHERE COALESCE(json_extract(meta,'$.internal'),0)=0" : "SELECT * FROM projects WHERE tenantId=? AND COALESCE(json_extract(meta,'$.internal'),0)=0").all(...(user.role === "admin" ? [] : [user.tenantId!])) as unknown as ManagedProject[]; }
  project(projectId: string, user?: Identity): ManagedProject {
    const project = this.db.prepare("SELECT * FROM projects WHERE id=?").get(projectId) as unknown as ManagedProject | undefined;
    if (!project || (user && (JSON.parse(project.meta).internal || (user.role !== "admin" && project.tenantId !== user.tenantId)))) throw new AccessError(404, "project_not_found");
    return project;
  }
  workerProject(presented: string): ManagedProject {
    const project = this.db.prepare("SELECT p.* FROM projects p JOIN tenants t ON t.id=p.tenantId WHERE p.tokenHash=? AND t.enabled=1").get(digest(presented)) as unknown as ManagedProject | undefined;
    if (!project) throw new AccessError(401, "invalid_worker_token");
    return project;
  }
  createProject(user: Identity, raw: Record<string, unknown>): { project: ManagedProject; token: string } {
    const tenantId = user.role === "admin" ? text(raw.tenantId, "tenant") : user.tenantId!;
    if (raw.tenantId !== undefined && raw.tenantId !== tenantId) throw new AccessError(403, "tenant_mismatch");
    if (!this.tenant(tenantId)?.enabled) throw new AccessError(404, "tenant_not_found");
    const source = raw.supply ?? "byok";
    if (source !== "byok" && source !== "platform") throw new AccessError(400, "invalid_supply");
    const projectId = id(), workerToken = token(), now = new Date(this.now()).toISOString();
    const meta = { id: projectId, name: text(raw.name, "project name"), description: typeof raw.description === "string" ? raw.description.slice(0, 10000) : "", tags: Array.isArray(raw.tags) ? raw.tags.filter(x => typeof x === "string").slice(0, 30) : [], spendLimitUsd: budget(raw.spendLimitUsd ?? null), archived: false, createdAt: now, updatedAt: now };
    const project: ManagedProject = { id: projectId, tenantId, supply: source, meta: JSON.stringify(meta), tokenHash: digest(workerToken) };
    this.db.prepare("INSERT INTO projects VALUES(?,?,?,?,?)").run(projectId, tenantId, source, project.meta, project.tokenHash);
    return { project, token: workerToken };
  }
  usage(tenantId: string) {
    const result = this.db.prepare("SELECT COALESCE(SUM(cost),0) spentUsd,COALESCE(SUM(CASE WHEN state IN ('running','unsettled') THEN reserved ELSE 0 END),0) reservedUsd,SUM(CASE WHEN state='unsettled' THEN 1 ELSE 0 END) unsettled, SUM(CASE WHEN state='running' THEN 1 ELSE 0 END) running FROM model_calls WHERE tenantId=?").get(tenantId) as { spentUsd: number; reservedUsd: number; unsettled: number; running: number };
    return { ...result, unsettled: result.unsettled ?? 0, running: result.running ?? 0 };
  }
  admitModel(project: ManagedProject, model: string, reserve: number): string {
    if (project.supply !== "platform") throw new AccessError(403, "platform_project_required");
    if (!Number.isFinite(reserve) || reserve < 0) throw new AccessError(400, "unknown_price");
    return this.transaction(() => {
      const tenant = this.tenant(project.tenantId)!;
      const usage = this.usage(project.tenantId);
      if (!tenant.enabled) throw new AccessError(403, "tenant_disabled");
      if (usage.unsettled) throw new AccessError(409, "usage_unsettled", "A prior platform call has unconfirmed usage; an administrator must reconcile it");
      if (tenant.budgetUsd !== null && (usage.spentUsd + usage.reservedUsd + reserve > tenant.budgetUsd || usage.spentUsd >= tenant.budgetUsd)) throw new AccessError(402, "platform_budget_exceeded");
      if (usage.running >= tenant.modelLimit) throw new AccessError(429, "model_concurrency_exceeded");
      const call = id();
      this.db.prepare("INSERT INTO model_calls VALUES(?,?,?,'running',?,NULL,?,?)").run(call, project.tenantId, project.id, reserve, this.now(), model);
      return call;
    });
  }
  settle(callId: string, cost: number | null) {
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new AccessError(400, "invalid_cost");
    this.db.prepare("UPDATE model_calls SET state=?,cost=? WHERE id=? AND state='running'").run(cost === null ? "unsettled" : "settled", cost, callId);
  }
  reconcile(user: Identity, callId: string, cost: unknown) {
    this.requireAdmin(user);
    const amount = budget(cost);
    if (amount === null) throw new AccessError(400, "invalid_cost");
    const updated = this.db.prepare("UPDATE model_calls SET state='settled',cost=? WHERE id=? AND state='unsettled'").run(amount, callId);
    if (!updated.changes) throw new AccessError(404, "unsettled_call_not_found");
  }
  acquireTask(project: ManagedProject, key: string, globalLimit = 5): string {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM task_leases WHERE projectId=? AND leaseKey=?").get(project.id, key) as { id: string } | undefined;
      if (existing) return existing.id;
      const global = this.db.prepare("SELECT COUNT(*) n FROM task_leases").get() as { n: number };
      const tenant = this.db.prepare("SELECT COUNT(*) n FROM task_leases WHERE tenantId=?").get(project.tenantId) as { n: number };
      if (global.n >= globalLimit || tenant.n >= this.tenant(project.tenantId)!.taskLimit) throw new AccessError(429, "task_concurrency_exceeded");
      const lease = id(); this.db.prepare("INSERT INTO task_leases VALUES(?,?,?,?)").run(lease, project.id, project.tenantId, key); return lease;
    });
  }
  releaseTask(project: ManagedProject, lease: string) { this.db.prepare("DELETE FROM task_leases WHERE id=? AND projectId=?").run(lease, project.id); }
  setting(key: string): string | undefined { return (this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined)?.value; }
  setSetting(key: string, value: string) { this.db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value); }
}

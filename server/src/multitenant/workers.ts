import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { atomicJson } from "../atomic-json.ts";
import { AccessError, digest, token, TenantStore, type ManagedProject } from "./store.ts";
import { redactWorkerDiagnostic } from "./diagnostics.ts";

interface Worker { child: ChildProcess; url: string; auth: string; project: ManagedProject; pending: boolean }
export class WorkerFleet {
  readonly live = new Map<string, Worker>();
  private starting = new Map<string, Promise<Worker>>();
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private stopping = new Map<string, Promise<void>>();
  private children = new Set<ChildProcess>();
  private changing = new Set<string>();
  private closing = false;
  private credentialWrites = new Map<string, Promise<unknown>>();
  constructor(readonly store: TenantStore, public managerUrl: string, readonly publicUrl: string) {}
  root(project: ManagedProject) { return path.join(this.store.root, "tenants", project.tenantId, "workspaces", project.id); }
  tenantEnv(tenantId: string) { return path.join(this.store.root, "tenants", tenantId, "credentials.env"); }
  async credentials(tenantId: string, body?: Record<string, unknown>): Promise<unknown> {
    const previous = this.credentialWrites.get(tenantId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      // Include workers already starting; new starts wait for this configuration transaction.
      await Promise.all([...this.starting].filter(([id]) => this.store.project(id).tenantId === tenantId).map(([, worker]) => worker));
      const projectId = `credentials-${tenantId}`;
      const meta = { id: projectId, name: "Credential settings", description: "", tags: [], archived: true, spendLimitUsd: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), internal: true };
      this.store.db.prepare("INSERT OR IGNORE INTO projects VALUES(?,?,'byok',?,?)").run(projectId, tenantId, JSON.stringify(meta), digest(token()));
      if (body) await this.stop(projectId); // Stage against the current shared files, not a previous save's snapshot.
      const worker = await this.ensure(this.store.project(projectId));
      const sharedDir = path.join(this.store.root, "tenants", tenantId, "pi-agent");
      const stagedDir = path.join(this.root(worker.project), "configuration-agent");
      const readJson = (file: string) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> : {};
      const beforeAuth = readJson(path.join(stagedDir, "auth.json"));
      const beforeMcp = readJson(path.join(stagedDir, "mcp.json"));
      const affected = body ? [...this.live.values()].filter(w => w.project.tenantId === tenantId && w.project.id !== projectId && !w.pending) : [];
      for (const w of affected) { w.pending = true; await this.control(w, "drain", "POST"); }
      const response = await fetch(`${worker.url}/credentials`, { method: body ? "PUT" : "GET", headers: { "X-Kady-Token": worker.auth, "X-Project-Id": projectId, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(60000) });
      const value = await response.json() as { detail?: string };
      if (!response.ok) {
        for (const w of affected) { await this.control(w, "resume", "POST"); w.pending = false; }
        throw new AccessError(response.status, "invalid_credentials", value.detail ?? "Credentials could not be saved");
      }
      if (body) {
        const afterAuth = readJson(path.join(stagedDir, "auth.json"));
        const auth = await ModelRuntime.create({ authPath: path.join(sharedDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
        for (const provider of Object.keys(beforeAuth)) if (!(provider in afterAuth)) await auth.logout(provider);
        const afterMcp = readJson(path.join(stagedDir, "mcp.json"));
        if (JSON.stringify(beforeMcp) !== JSON.stringify(afterMcp)) {
          const destination = path.join(sharedDir, "mcp.json"), current = readJson(destination);
          const original = beforeMcp.mcpServers as Record<string, unknown> ?? {}, changed = afterMcp.mcpServers as Record<string, unknown> ?? {};
          const merged = { ...(current.mcpServers as Record<string, unknown> ?? {}) };
          for (const name of new Set([...Object.keys(original), ...Object.keys(changed)])) if (JSON.stringify(original[name]) !== JSON.stringify(changed[name])) {
            if (name in changed) merged[name] = changed[name]; else delete merged[name];
          }
          atomicJson(destination, { ...current, mcpServers: merged });
        }
        const destination = this.tenantEnv(tenantId), temporary = `${destination}.pending`;
        fs.writeFileSync(temporary, fs.readFileSync(path.join(this.root(worker.project), "worker.env")), { mode: 0o600 });
        fs.renameSync(temporary, destination);
        await this.reloadTenant(tenantId);
      }
      return value;
    });
    this.credentialWrites.set(tenantId, operation);
    try { return await operation; } finally { if (this.credentialWrites.get(tenantId) === operation) this.credentialWrites.delete(tenantId); }
  }
  async ensure(project: ManagedProject): Promise<Worker> {
    if (this.closing) throw new AccessError(503, "management_stopping");
    if (this.changing.has(project.id)) throw new AccessError(409, "project_reloading");
    await this.stopping.get(project.id);
    project = this.store.project(project.id);
    const live = this.live.get(project.id);
    if (live && live.child.exitCode === null && live.child.signalCode === null) return live;
    if (JSON.parse(project.meta).internal !== true) await this.credentialWrites.get(project.tenantId);
    let pending = this.starting.get(project.id);
    if (!pending) {
      pending = this.start(project).finally(() => this.starting.delete(project.id));
      this.starting.set(project.id, pending);
    }
    return pending;
  }
  private async start(project: ManagedProject): Promise<Worker> {
    const root = this.root(project), projects = path.join(root, "projects");
    fs.mkdirSync(path.join(projects, project.id), { recursive: true, mode: 0o700 });
    const metaFile = path.join(projects, project.id, "project.json");
    if (!fs.existsSync(metaFile)) fs.writeFileSync(metaFile, project.meta, { mode: 0o600 });
    fs.writeFileSync(path.join(projects, "index.json"), JSON.stringify({ projects: { [project.id]: JSON.parse(fs.readFileSync(metaFile, "utf8")) } }), { mode: 0o600 });
    const tenantRoot = path.join(this.store.root, "tenants", project.tenantId);
    const internal = JSON.parse(project.meta).internal === true;
    const agentDir = internal ? path.join(root, "configuration-agent") : project.supply === "byok" ? path.join(tenantRoot, "pi-agent") : path.join(root, "platform-agent");
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    if (internal) for (const name of ["auth.json", "mcp.json"]) {
      const source = path.join(tenantRoot, "pi-agent", name), destination = path.join(agentDir, name);
      if (fs.existsSync(source)) fs.copyFileSync(source, destination); else fs.rmSync(destination, { force: true });
    }
    if (project.supply === "platform") {
      fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: `${this.managerUrl}/api/platform/v1`, api: "openai-completions", apiKey: "$OPENROUTER_API_KEY" } } }), { mode: 0o600 });
    }
    const envFile = path.join(root, "worker.env");
    const tenantEnv = this.tenantEnv(project.tenantId);
    fs.writeFileSync(envFile, fs.existsSync(tenantEnv) ? fs.readFileSync(tenantEnv) : "", { mode: 0o600 });
    const apiToken = token(), projectToken = token();
    this.store.db.prepare("UPDATE projects SET tokenHash=? WHERE id=?").run(digest(projectToken), project.id);
    project = { ...project, tokenHash: digest(projectToken) };
    const env: NodeJS.ProcessEnv = {};
    for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL", "TERM", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, {
      KADY_ENV_FILE: envFile, KADY_MANAGED_PROJECT: project.id, KADY_MANAGED_SUPPLY: project.supply,
      KADY_MANAGEMENT_URL: this.managerUrl, KADY_PROJECT_TOKEN: projectToken,
      KADY_PROJECTS_ROOT: projects, PI_CODING_AGENT_DIR: agentDir,
      KADY_SKILLS_CACHE_DIR: path.join(tenantRoot, "skills-cache"), KADY_OFFICE_ASSETS_DIR: path.join(tenantRoot, "office-assets"),
      KADY_HOST: "127.0.0.1", KADY_PORT: "0", KADY_REQUIRE_AUTH: "1", KADY_AUTH_TOKEN: apiToken,
      KADY_ALLOWED_ORIGINS: this.publicUrl, KADY_LAUNCHER: "1", LOG_LEVEL: "warn",
      ...(project.supply === "platform" ? { OPENROUTER_API_KEY: projectToken, OPENROUTER_BASE_URL: `${this.managerUrl}/api/platform/v1` } : {}),
    });
    const child = spawn(process.execPath, ["--import", "tsx", path.resolve(import.meta.dirname, "../index.ts")], { cwd: path.resolve(import.meta.dirname, "../.."), env, stdio: ["ignore", "ignore", "pipe", "ipc"], detached: process.platform !== "win32" });
    this.children.add(child);
    child.once("exit", () => {
      this.children.delete(child);
      this.store.db.prepare("DELETE FROM task_leases WHERE projectId=? AND EXISTS(SELECT 1 FROM projects WHERE id=? AND tokenHash=?)").run(project.id, project.id, project.tokenHash);
    });
    // Redact complete lines so a credential split across pipe chunks is still removed.
    const log = fs.createWriteStream(path.join(root, "worker.log"), { flags: "a", mode: 0o600 });
    let diagnostic = "";
    const redact = (line: string) => redactWorkerDiagnostic(line, envFile, path.join(agentDir, "auth.json"), [apiToken, projectToken]);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", chunk => {
      diagnostic += chunk;
      if (diagnostic.length > 1024 * 1024) { log.write("[oversized worker diagnostic withheld]\n"); diagnostic = ""; }
      const lines = diagnostic.split("\n"); diagnostic = lines.pop()!;
      for (const line of lines) log.write(redact(line + "\n"));
    });
    child.stderr?.once("end", () => { if (diagnostic) log.write(redact(diagnostic)); log.end(); });
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill("SIGTERM"); reject(new AccessError(503, "worker_start_timeout")); }, 60000);
      child.once("error", () => { clearTimeout(timeout); reject(new AccessError(503, "worker_start_failed")); });
      child.once("exit", () => { clearTimeout(timeout); reject(new AccessError(503, "worker_start_failed")); });
      child.on("message", message => {
        const value = message as { type?: string; address?: string };
        if (value.type === "kady-ready" && typeof value.address === "string" && /^http:\/\/127\.0\.0\.1:\d+$/.test(value.address)) { clearTimeout(timeout); resolve(value.address); }
      });
    });
    const worker: Worker = { child, url, auth: apiToken, project, pending: false };
    this.live.set(project.id, worker);
    child.once("exit", () => {
      if (this.live.get(project.id) === worker) this.live.delete(project.id);
    });
    return worker;
  }
  async control(worker: Worker, action: string, method = "GET", body?: unknown) {
    const response = await fetch(`${worker.url}/__managed/${action}`, { method, headers: { "X-Kady-Token": worker.auth, "X-Project-Id": worker.project.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new AccessError(response.status, "worker_control_failed");
    return response.json() as Promise<{ busy: boolean; scheduled: boolean; draining?: boolean }>;
  }
  async stop(projectId: string) {
    const existing = this.stopping.get(projectId);
    if (existing) return existing;
    const worker = this.live.get(projectId);
    if (!worker) return;
    this.live.delete(projectId);
    const stopped = new Promise<void>(resolve => {
      if (worker.child.exitCode !== null || worker.child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { try { process.kill(-worker.child.pid!, "SIGKILL"); } catch { worker.child.kill("SIGKILL"); } }, 10000);
      worker.child.once("exit", () => { clearTimeout(timer); resolve(); });
      try { if (process.platform !== "win32") process.kill(-worker.child.pid!, "SIGTERM"); else worker.child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
    });
    this.stopping.set(projectId, stopped);
    try { await stopped; } finally { if (this.stopping.get(projectId) === stopped) this.stopping.delete(projectId); }
  }
  async changeSupply(project: ManagedProject, supply: unknown) {
    if (supply !== "byok" && supply !== "platform") throw new AccessError(400, "invalid_supply");
    if (supply === project.supply) return;
    const worker = await this.ensure(project);
    if (worker.pending) throw new AccessError(409, "credentials_pending");
    if (this.changing.has(project.id)) throw new AccessError(409, "project_reloading");
    this.changing.add(project.id);
    try {
    const state = await this.control(worker, "drain", "POST");
    if (state.busy || state.scheduled) {
      await this.control(worker, "resume", "POST");
      throw new AccessError(409, "project_busy", "Finish active work and pause schedules before changing supply");
    }
    await this.stop(project.id);
    this.store.db.prepare("UPDATE projects SET supply=? WHERE id=?").run(supply, project.id);
    await this.start(this.store.project(project.id));
    } finally { this.changing.delete(project.id); }
  }
  async reloadTenant(tenantId: string) {
    for (const worker of [...this.live.values()]) if (worker.project.tenantId === tenantId) {
      worker.pending = true;
      await this.control(worker, "drain", "POST");
    }
    const reload = async () => {
      if (this.closing) return;
      for (const worker of [...this.live.values()]) if (worker.project.tenantId === tenantId && worker.pending) {
        if (this.changing.has(worker.project.id)) continue;
        this.changing.add(worker.project.id);
        try {
          const state = await this.control(worker, "state");
          if (!state.busy) { await this.stop(worker.project.id); await this.start(this.store.project(worker.project.id)); }
        } catch { /* Pending stays visible and blocked; a failed reload never falls back. */ }
        finally { this.changing.delete(worker.project.id); }
      }
    };
    await reload();
    const previous = this.timers.get(tenantId); if (previous) clearInterval(previous);
    let polling = false;
    const timer = setInterval(() => { if (polling || this.closing) return; polling = true; void reload().finally(() => {
      polling = false;
      if (![...this.live.values()].some(w => w.project.tenantId === tenantId && w.pending)) { clearInterval(timer); this.timers.delete(tenantId); }
    }); }, 1000);
    timer.unref(); this.timers.set(tenantId, timer);
  }
  async close() {
    this.closing = true;
    for (const timer of this.timers.values()) clearInterval(timer);
    for (const child of this.children) if (![...this.live.values()].some(w => w.child === child)) child.kill("SIGTERM");
    await Promise.allSettled([...this.starting.values()]);
    await Promise.all([...this.live.keys()].map(id => this.stop(id)));
  }
}

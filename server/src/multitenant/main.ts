import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { TenantStore } from "./store.ts";
import { buildManagementApp } from "./server.ts";
import { WorkerFleet } from "./workers.ts";
import { multiTenantEnabled } from "../../../multi-tenancy-mode.mjs";

const root = path.resolve(process.env.KADY_MT_ROOT || path.join(os.homedir(), ".kady", "multitenant"));
if (process.platform !== "win32") process.umask(0o077);
if (process.argv.includes("--init-admin")) {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  const username = process.env.KADY_ADMIN_USERNAME || await input.question("Administrator username: ");
  input.close();
  let password = process.env.KADY_ADMIN_PASSWORD;
  if (!password) {
    const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
    const prompt = createInterface({ input: process.stdin, output: silent, terminal: Boolean(process.stdin.isTTY) });
    process.stdout.write("Administrator password (at least 12 characters): ");
    password = await prompt.question(""); prompt.close(); process.stdout.write("\n");
  }
  const store = new TenantStore(root);
  try { await store.initializeAdmin(username, password); console.log("Administrator initialized."); } finally { store.close(); }
} else {
  if (!multiTenantEnabled()) throw new Error("Set KADY_MULTI_TENANT=1 to start this entry; use the existing launcher for single-user mode");
  const port = Number(process.env.KADY_MT_PORT || process.env.KADY_FRONTEND_PORT || 3000);
  const uiPort = Number(process.env.KADY_UI_INTERNAL_PORT || port + 1);
  const host = process.env.KADY_MT_HOST || "127.0.0.1";
  const publicUrl = process.env.KADY_PUBLIC_URL || `http://localhost:${port}`;
  if (![port, uiPort].every(p => Number.isInteger(p) && p > 0 && p <= 65535) || port === uiPort) throw new Error("Invalid multi-tenant ports");
  // Validate the mode before creating state; an invalid/disabled mode never creates a database.
  const store = new TenantStore(root);
  const managerUrl = `http://127.0.0.1:${port}`;
  // Shared scientific helpers are prepared once here, rather than once per project worker.
  const { syncHelperVenv } = await import("../helpers-env.ts");
  syncHelperVenv();
  const fleet = new WorkerFleet(store, managerUrl, new URL(publicUrl).origin);
  const app = await buildManagementApp({ store, publicUrl, managerUrl, fleet, uiUrl: `http://127.0.0.1:${uiPort}` });
  const address = await app.listen({ port, host });
  console.log(`Kady multi-tenant entry listening at ${address}; trusted-host deployment, no OS isolation.`);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => {
    app.server.closeAllConnections();
    void app.close().then(() => { store.close(); process.exit(0); });
  });
  // Restore persistent projects with schedules/remote jobs as well as projects opened by browsers.
  const projects = store.db.prepare("SELECT * FROM projects").all();
  for (const raw of projects) {
    const project = store.project(String(raw.id));
    const sandbox = path.join(fleet.root(project), "projects", project.id, "sandbox");
    if (fs.existsSync(path.join(sandbox, ".pi/subagents/schedules")) || fs.existsSync(path.join(sandbox, ".kady/modal/jobs"))) {
      await fleet.ensure(project).catch(() => console.error(`Project ${project.id} could not restore its worker; retry from the project UI.`));
    }
  }
}

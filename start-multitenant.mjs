import { multiTenantEnabled } from "./multi-tenancy-mode.mjs";

export async function startMultitenant({ startService, waitFor, stopAll, log }) {
  if (!multiTenantEnabled()) throw new Error("Multi-tenant mode is not enabled");
  const port = Number(process.env.KADY_FRONTEND_PORT || 3000);
  const internalPort = Number(process.env.KADY_UI_INTERNAL_PORT || port + 1);
  if (![port, internalPort].every(p => Number.isInteger(p) && p > 0 && p <= 65535) || port === internalPort) throw new Error("Invalid multi-tenant ports");
  process.env.KADY_MT_PORT = String(port);
  process.env.KADY_UI_INTERNAL_PORT = String(internalPort);
  process.env.KADY_PUBLIC_URL ||= `http://localhost:${port}`;
  process.env.NEXT_PUBLIC_ADK_API_URL = "/api";
  process.env.NEXT_PUBLIC_KADY_MULTI_TENANT = "1";
  startService(`Internal UI on ${internalPort}`, "web", ["run", "dev", "--", "-p", String(internalPort), "-H", "127.0.0.1"]);
  startService(`Multi-tenant entry on ${port}`, "server", ["run", "start:multitenant"]);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => stopAll(0));
  await waitFor(`http://127.0.0.1:${port}/health`, "multi-tenant entry", 120);
  await waitFor(`http://127.0.0.1:${internalPort}/`, "internal UI", 180);
  log(`Multi-tenant UI: ${process.env.KADY_PUBLIC_URL}`);
}

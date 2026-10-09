import type { FastifyInstance } from "fastify";
import { Agent, fetch } from "undici";
import { runBroker } from "../agent/run-broker.ts";
import { isRunClaimed } from "../agent/run-pipeline.ts";
import { liveSubagentSessions, subagentHost } from "../agent/subagent-control.ts";
import { listSchedules } from "../agent/scheduler.ts";
import { modalJobManager } from "../modal/manager.ts";
import { isTerminalModalState } from "../modal/types.ts";
import { isOneShotModelOperation, startsManagedWork } from "./operations.ts";

let draining = false;
let requests = 0;
const leases = new Map<string, Promise<string>>();
const direct = new Agent();
export class ManagedAdmissionError extends Error {
  constructor(public status: number, public reason: string, message: string) { super(message); }
}
async function callback(action: string, body: unknown) {
  const response = await fetch(`${process.env.KADY_MANAGEMENT_URL}/api/internal/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.KADY_PROJECT_TOKEN}` },
    body: JSON.stringify(body), dispatcher: direct, signal: AbortSignal.timeout(10000),
  });
  const data = await response.json() as { lease: string; reason?: string; detail?: string };
  if (!response.ok) throw new ManagedAdmissionError(response.status, data.reason ?? "management_unavailable", data.detail ?? "Management service refused the task");
  return data;
}
export function acquireManagedTask(key: string): Promise<string> {
  const active = leases.get(key);
  if (active) return active;
  if (draining) return Promise.reject(new ManagedAdmissionError(409, "credentials_pending", "Wait for configuration reload"));
  const acquiring = callback("tasks/acquire", { key }).then(r => r.lease).catch(error => { leases.delete(key); throw error; });
  leases.set(key, acquiring);
  return acquiring;
}
export async function releaseManagedTask(key: string) {
  const pending = leases.get(key);
  if (!pending) return;
  try { const lease = await pending; await callback("tasks/release", { lease }); }
  finally { if (leases.get(key) === pending) leases.delete(key); }
}
export async function registerManagedWorker(app: FastifyInstance) {
  const projectId = process.env.KADY_MANAGED_PROJECT!;
  app.addHook("onRoute", options => {
    if (options.method === "GET" || options.method === "HEAD" || options.url.startsWith("/__managed/") || options.url.startsWith("/subagents/meter/")) return;
    const handler = options.handler;
    options.handler = async function(req, reply) {
      const key = `request:${req.id}`;
      const modelOperation = isOneShotModelOperation(options.url);
      requests++;
      try {
        if (modelOperation) await acquireManagedTask(key);
        return await handler.call(this, req, reply);
      } catch (error) {
        if (error instanceof ManagedAdmissionError) return reply.code(error.status).send({ reason: error.reason, detail: error.message });
        throw error;
      } finally { requests--; if (modelOperation) await releaseManagedTask(key).catch(() => {}); }
    };
  });
  const state = async () => {
    let childrenBusy = false;
    for (const session of liveSubagentSessions(projectId)) {
      // An unreadable fleet is unknown, never proof that a process can safely be replaced.
      const snapshot = await subagentHost(projectId, session).rpc("status");
      const snapshotData = snapshot.asyncSnapshot as { runs?: { state?: string; children?: unknown[] }[]; omitted?: { runs?: number; children?: number; byteLimitExceeded?: boolean } } | undefined;
      const active = (node: { state?: string; children?: unknown[] }): boolean => !["complete", "failed", "partial", "stopped", "rejected"].includes(node.state ?? "") || Boolean(node.children?.some(child => active(child as typeof node)));
      if (!snapshotData?.runs || snapshotData.runs.some(active) || Object.values(snapshotData.omitted ?? {}).some(Boolean)) childrenBusy = true;
    }
    const schedules = listSchedules(projectId);
    return {
      busy: requests > 0 || leases.size > 0 || runBroker.activeForProject(projectId).length > 0 || childrenBusy || modalJobManager.list(projectId).some(job => !isTerminalModalState(job.state)) || schedules.some(schedule => Boolean(schedule.activeRunId)),
      scheduled: schedules.some(schedule => !schedule.paused), draining,
    };
  };
  app.get("/__managed/state", state);
  app.post("/__managed/drain", async () => { draining = true; return state(); });
  app.post("/__managed/resume", async () => { draining = false; return state(); });
  app.addHook("preHandler", async (req, reply) => {
    if (req.url.startsWith("/__managed/")) return;
    const route = req.url.split("?")[0];
    if (draining && !["GET", "HEAD"].includes(req.method) && startsManagedWork(route)) return reply.code(409).send({ reason: "credentials_pending", detail: "Wait for configuration reload" });
    if (process.env.KADY_MANAGED_SUPPLY === "platform" && !route.startsWith("/subagents/meter/")) {
      const model = (req.body as { model?: unknown } | undefined)?.model;
      if (typeof model === "string" && !model.startsWith("openrouter/") && !model.startsWith("fusion/")) return reply.code(400).send({ reason: "platform_model_required", detail: "Select an OpenRouter platform model" });
    }
    const match = route.match(/^\/sessions\/([^/]+)\/(run|compact)$/);
    if (req.method === "POST" && match) {
      const key = `session:${match[1]}`;
      try { await acquireManagedTask(key); }
      catch (error) { const failure = error as ManagedAdmissionError; return reply.code(failure.status ?? 503).send({ reason: failure.reason ?? "management_unavailable", detail: failure.message }); }
      reply.raw.once("close", () => {
        // Browser disconnect does not end a broker-owned run.
        const timer = setInterval(() => {
          if (!isRunClaimed(projectId, match[1]) && !runBroker.activeForProject(projectId).some(run => run.sessionId === match[1])) { clearInterval(timer); void releaseManagedTask(key).catch(() => {}); }
        }, 100);
        timer.unref();
      });
    }
  });
  let failures = 0;
  const timer = setInterval(() => { void callback("heartbeat", {}).then(() => { failures = 0; }).catch(() => { if (++failures >= 3) process.exit(1); }); }, 2000);
  timer.unref();
  app.addHook("onClose", async () => { clearInterval(timer); await direct.close(); });
}

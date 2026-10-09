/** Runs in both the backend and detached Pi runner. No shared process identity:
 * owner/model/auth are captured per session and per request. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Agent, fetch } from 'undici';
const direct = new Agent();
let localMeter;
const childOwners = new Map();
const childAdmissions = new Map();
const childCompletions = new Map();
export function finishManagedChild(sessionId) {
  const existing = childCompletions.get(sessionId);
  if (existing) return existing;
  const owner = childOwners.get(sessionId), admitted = childAdmissions.get(sessionId);
  if (!owner || !admitted) return Promise.resolve();
  const completed = admitted.then(() => meter('task-end', { ...owner, requestId: randomUUID() })).catch(() => {});
  childCompletions.set(sessionId, completed);
  return completed;
}
const restrictedRuntimes = new WeakSet();
export function restrictPlatformModels(runtime) {
  if (process.env.KADY_MANAGED_SUPPLY !== 'platform' || restrictedRuntimes.has(runtime)) return;
  restrictedRuntimes.add(runtime);
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = async (target, options) => {
    if ((typeof target === 'string' ? target : target.provider) !== 'openrouter') throw new Error('Platform model access is limited to OpenRouter; choose BYOK to use another provider');
    return getAuth(target, options);
  };
}
/** Per-work auth snapshot, not a process/global credential override. Child runtimes use the same public SDK contract. */
export function captureManagedAuth(base, runtime, ownerKey = () => 'child-lifetime') {
  if (!process.env.KADY_MANAGED_PROJECT) return base;
  let current;
  const credentials = new Map();
  return async (model, context, options) => {
    const owner = await ownerKey();
    if (owner !== current) { current = owner; credentials.clear(); }
    if (process.env.KADY_MANAGED_SUPPLY === 'platform' && model.provider !== 'openrouter') throw new Error('Platform projects require OpenRouter');
    const key = `${model.provider}/${model.id}`;
    let pending = credentials.get(key);
    if (!pending) { pending = runtime.getAuth(model, { signal: options?.signal }); credentials.set(key, pending); }
    const resolved = await pending;
    if (!resolved) throw new Error(`Provider is not configured: ${model.provider}`);
    return base({ ...model, ...(resolved.auth.baseUrl ? { baseUrl: resolved.auth.baseUrl } : {}) }, context, {
      ...options, apiKey: resolved.auth.apiKey,
      headers: { ...options?.headers, ...resolved.auth.headers }, env: { ...options?.env, ...resolved.env },
    });
  };
}
export function setHostMeter(handler) { localMeter = handler; }
function projectOwner(cwd) {
  for (let dir = path.resolve(cwd);;) {
    if (path.basename(dir) === 'sandbox') {
      const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'project.json'), 'utf8'));
      if (meta.id !== path.basename(path.dirname(dir))) throw new Error('Invalid child project identity');
      return { projectId: meta.id, sandbox: dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Subagent launch must remain in a Kady project sandbox');
    dir = parent;
  }
}
async function meter(action, input) {
  if (localMeter) return localMeter(action, input);
  const url = new URL(process.env.KADY_INTERNAL_URL || `http://127.0.0.1:${process.env.KADY_PORT || process.env.PORT || 8000}`);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Invalid Kady internal URL');
  url.pathname = `/subagents/meter/${action}`;
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', dispatcher: direct,
    signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-Project-Id': input.projectId,
      ...(process.env.KADY_AUTH_TOKEN ? { 'X-Kady-Token': process.env.KADY_AUTH_TOKEN } : {}) },
    body: JSON.stringify(input),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || 'Subagent accounting unavailable');
  return result;
}
function persistUsage(request) {
  if (!request.sandbox) return undefined;
  const dir = path.join(request.sandbox, '.kady', 'subagent-usage-pending');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${request.requestId}.json`), tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(request)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  return file;
}
export function meteredStream(base, owner, usingOAuth) {
  return async (model, context, options) => {
    const request = { ...owner, requestId: randomUUID(), provider: model.provider, model: model.id,
      authType: usingOAuth(model) ? 'oauth' : 'api_key' };
    await meter('admit', request);
    let stream;
    try { stream = await base(model, context, options); }
    catch (error) { if (process.env.KADY_MANAGED_PROJECT) await meter('task-end', request); throw error; }
    // Meter before exposing the terminal event, so the next request and the
    // parent's completion cannot race ahead of accounting. Never consume twice.
    let settled;
    const settle = (message) => settled ??= (async () => {
      const usage = { ...request, usage: message?.usage };
      const pending = persistUsage(usage);
      await meter('usage', usage);
      if (pending) fs.rmSync(pending, { force: true });
    })();
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of stream) {
          if (event.type === 'done' || event.type === 'error') await settle(event.message || event.error);
          yield event;
        }
      },
      async result() { const message = await stream.result(); await settle(message); return message; },
    };
  };
}
export function attachChildSession(session, launch, runtime) {
  restrictPlatformModels(runtime);
  const parentId = launch.runtime.orchestratorSessionId || launch.runtime.parentSessionId || session.sessionId;
  const owner = { ...projectOwner(launch.cwd), sessionId: childOwners.get(parentId)?.sessionId || parentId,
    childSessionId: session.sessionId, sessionFile: session.sessionFile, kind: 'subagent', runId: launch.runtime.runId };
  childOwners.set(session.sessionId, owner);
  const admitted = process.env.KADY_MANAGED_PROJECT ? meter('task-start', { ...owner, requestId: randomUUID() }) : Promise.resolve();
  childAdmissions.set(session.sessionId, admitted);
  admitted.catch(() => {}); // The stream awaits and surfaces admission; no orphan rejection before prompt() starts.
  const dispose = session.dispose.bind(session);
  session.dispose = () => {
    const cleanup = () => { childOwners.delete(session.sessionId); childAdmissions.delete(session.sessionId); childCompletions.delete(session.sessionId); return dispose(); };
    if (!process.env.KADY_MANAGED_PROJECT) return cleanup();
    // The detached runner awaits dispose before process.exit; retain that await through accounting.
    return finishManagedChild(session.sessionId).finally(cleanup);
  };
  const authModes = new Map();
  const usingOAuth = model => {
    if (!process.env.KADY_MANAGED_PROJECT) return runtime.isUsingOAuth(model.provider);
    if (!authModes.has(model.provider)) authModes.set(model.provider, runtime.isUsingOAuth(model.provider));
    return authModes.get(model.provider);
  };
  const stream = meteredStream(captureManagedAuth(session.agent.streamFunction.bind(session.agent), runtime), owner, usingOAuth);
  session.agent.streamFunction = async (...args) => { await admitted; return stream(...args); };
}
export function watchdogStream(ctx, base) {
  const sessionId = ctx.sessionManager.getSessionId();
  return meteredStream(base, { ...projectOwner(ctx.cwd), sessionId, ...childOwners.get(sessionId), kind: 'watchdog' },
    model => ctx.modelRegistry.isUsingOAuth(model));
}

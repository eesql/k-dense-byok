import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { TenantStore } from "../src/multitenant/store.ts";
import { ModelGateway, bundledPrices } from "../src/multitenant/model-gateway.ts";
import { buildManagementApp } from "../src/multitenant/server.ts";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

it("prices native image models and Fusion using all panel calls plus the judge twice", () => {
  const prices = bundledPrices();
  expect(prices.get("openai/gpt-image-2.5-sunburst")!.output).toBeGreaterThan(0);
  const fake = { prices: new Map([["panel", { input: 1, output: 2 }], ["judge", { input: 3, output: 4 }]]) } as ModelGateway;
  expect(ModelGateway.prototype.requestPrice.call(fake, { model: "openrouter/fusion", plugins: [{ analysis_models: ["panel"], model: "judge" }] })).toEqual({ input: 7, output: 10 });
  expect(ModelGateway.prototype.requestPrice.call(fake, { model: "panel", models: ["unknown"] })).toBeUndefined();
});

it("admits Pi's large output limits, forwards one token field and reserves the full requested amount", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-gateway-tokens-"));
  const store = new TenantStore(root), admin = await store.initializeAdmin("administrator", "synthetic-admin-password");
  const tenant = store.createTenant(admin, { name: "Lab", budgetUsd: 100 });
  const { token } = store.createProject(admin, { tenantId: tenant.id, name: "Project", supply: "platform" });
  store.setSetting("openrouterKey", "synthetic-master-key");
  const forwarded: Record<string, unknown>[] = [];
  const gateway = new ModelGateway(store, new Map([["test", { input: 0, output: 0.00001 }]]), "http://mock.invalid", async (_url, options) => {
    forwarded.push(JSON.parse(String(options?.body)));
    expect(store.usage(tenant.id).reservedUsd).toBeCloseTo(Number(forwarded.at(-1)!.max_tokens ?? forwarded.at(-1)!.max_completion_tokens) * 0.00001);
    return Response.json({ choices: [], usage: { cost: 0 } });
  });
  const app = await buildManagementApp({ store, publicUrl: "http://localhost:3000", managerUrl: "http://127.0.0.1:0", gateway });
  const call = (limits: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/platform/v1/chat/completions", headers: { authorization: `Bearer ${token}` }, payload: { model: "test", messages: [], ...limits } });
  try {
    const large = openrouterProvider().getAllModels!().find(model => model.maxTokens > 131072)!.maxTokens;
    for (const field of ["max_tokens", "max_completion_tokens"]) {
      const response = await call({ [field]: large });
      expect(response.statusCode, response.body).toBe(200);
      expect(forwarded.at(-1)![field]).toBe(large);
      expect(Object.keys(forwarded.at(-1)!).filter(key => ["max_tokens", "max_completion_tokens"].includes(key))).toHaveLength(1);
    }
    for (const value of [0, -1, 1.5, "100", Number.MAX_SAFE_INTEGER + 1]) {
      expect((await call({ max_tokens: value })).statusCode).toBe(400);
    }
    expect((await call({ max_tokens: 10, max_completion_tokens: 20 })).statusCode).toBe(400);
    expect(forwarded).toHaveLength(2);
    store.patchTenant(admin, tenant.id, { budgetUsd: 1 });
    expect((await call({ max_tokens: large })).statusCode).toBe(402);
    expect(forwarded).toHaveLength(2);
  } finally { await app.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it("streams before completion, counts in-flight calls, and retains unconfirmed cost after a disconnect", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-gateway-stream-"));
  const store = new TenantStore(root), admin = await store.initializeAdmin("administrator", "synthetic-admin-password");
  const tenant = store.createTenant(admin, { name: "Lab", modelLimit: 1, budgetUsd: 10 });
  const { project, token } = store.createProject(admin, { tenantId: tenant.id, name: "Project", supply: "platform" });
  store.setSetting("openrouterKey", "synthetic-master-key");
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let providerKey = "";
  const encoder = new TextEncoder();
  const fetcher: typeof fetch = async (_url, options) => {
    providerKey = new Headers(options?.headers).get("authorization") ?? "";
    return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
      options?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
  };
  const gateway = new ModelGateway(store, new Map([["test", { input: 0.00001, output: 0.00001 }]]), "http://mock.invalid", fetcher);
  const app = await buildManagementApp({ store, publicUrl: "http://localhost:3000", managerUrl: "http://127.0.0.1:0", gateway });
  const url = await app.listen({ port: 0, host: "127.0.0.1" });
  const call = (signal?: AbortSignal) => fetch(`${url}/api/platform/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "test", messages: [{ role: "user", content: "Hi" }], max_tokens: 10, stream: true }), signal });
  let phase = "first response";
  try {
    const response = await call();
    phase = "first chunk";
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
    expect(providerKey).toBe("Bearer synthetic-master-key");
    expect(store.usage(tenant.id).running).toBe(1);
    phase = "concurrent rejection";
    expect((await call()).status).toBe(429);
    stream!.enqueue(encoder.encode('data: {"usage":{"cost":0.12}}\n\ndata: [DONE]\n\n')); stream!.close();
    phase = "completed stream";
    while (!(await reader.read()).done) {}
    await vi.waitFor(() => expect(store.usage(tenant.id).spentUsd).toBe(0.12));
    phase = "second response";
    const abort = new AbortController(), second = await call(abort.signal);
    await second.body!.getReader().read(); abort.abort();
    phase = "disconnect settlement";
    await vi.waitFor(() => expect(store.usage(tenant.id).unsettled).toBe(1));
    expect(store.usage(tenant.id).running).toBe(0);
    expect((await call()).status).toBe(409);
    expect(store.project(project.id).supply).toBe("platform");
  } catch (error) { throw new Error(`${phase}: ${(error as Error).message}`); }
  finally { stream?.error(new Error("test shutdown")); app.server.closeAllConnections(); await app.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 15000);

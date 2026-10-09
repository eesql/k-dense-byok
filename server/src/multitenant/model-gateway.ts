import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AccessError, TenantStore } from "./store.ts";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { fusionPanelModels, fusionJudgeModel, JUDGE_CALLS_PER_TURN } from "../agent/models.ts";
import { listOpenRouterModels } from "../agent/openrouter-models.ts";

export interface ModelPrice { input: number; output: number }
export function bundledPrices(): Map<string, ModelPrice> {
  const rows = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../..", "web/src/data/models.json"), "utf8")) as { id: string; pricing?: { prompt: number; completion: number } }[];
  const prices = new Map<string, ModelPrice>();
  for (const model of openrouterProvider().getAllModels?.() ?? []) if (model.cost && [model.cost.input, model.cost.output].every(x => Number.isFinite(x) && x >= 0) && (model.cost.input + model.cost.output > 0 || model.id.endsWith(":free"))) prices.set(model.id, { input: model.cost.input / 1e6, output: model.cost.output / 1e6 });
  for (const row of rows) if (row.id.startsWith("openrouter/") && row.pricing && [row.pricing.prompt, row.pricing.completion].every(x => Number.isFinite(x) && x >= 0) && (row.pricing.prompt + row.pricing.completion > 0 || row.id.endsWith(":free"))) prices.set(row.id.slice(11), { input: row.pricing.prompt / 1e6, output: row.pricing.completion / 1e6 });
  return prices;
}
export class ModelGateway {
  constructor(readonly store: TenantStore, readonly prices = bundledPrices(), readonly upstream = "https://openrouter.ai/api/v1/chat/completions", readonly fetcher: typeof fetch = fetch) {}
  async models() {
    const key = this.store.setting("openrouterKey");
    if (!key) return { configured: false, models: [] };
    const models = await listOpenRouterModels(key, new URL("../models/user", this.upstream).href, this.fetcher);
    // Only expose platform models whose costs the gateway can reserve.
    return { configured: true, models: models.filter(model => this.prices.has(model.id.slice(11))) };
  }
  requestPrice(raw: Record<string, unknown>): ModelPrice | undefined {
    if (raw.model === "openrouter/fusion") {
      const panel = fusionPanelModels(raw), judge = fusionJudgeModel(raw);
      if (!panel.length || panel.length > 8 || !judge || panel.some(model => typeof model !== "string")) return undefined;
      const refs = [...panel, ...Array<string>(JUDGE_CALLS_PER_TURN).fill(judge)], prices = refs.map(model => this.prices.get(model));
      if (prices.some(price => !price)) return undefined;
      return prices.reduce<ModelPrice>((sum, price) => ({ input: sum.input + price!.input, output: sum.output + price!.output }), { input: 0, output: 0 });
    }
    const candidates = raw.models === undefined ? [raw.model] : Array.isArray(raw.models) && raw.models.length <= 32 ? [raw.model, ...raw.models] : [];
    const prices = candidates.map(model => typeof model === "string" ? this.prices.get(model) : undefined);
    if (!prices.length || prices.some(price => !price)) return undefined;
    return { input: Math.max(...prices.map(p => p!.input)), output: Math.max(...prices.map(p => p!.output)) };
  }
  async handle(req: FastifyRequest, reply: FastifyReply) {
    const bearer = req.headers.authorization?.match(/^Bearer ([\w-]{40,128})$/i)?.[1];
    if (!bearer) throw new AccessError(401, "invalid_worker_token");
    const project = this.store.workerProject(bearer);
    const raw = req.body as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.model !== "string" || !Array.isArray(raw.messages)) throw new AccessError(400, "invalid_model_request");
    const price = this.requestPrice(raw);
    if (!price) throw new AccessError(400, "unknown_price", "This platform model has no known price");
    const apiKey = this.store.setting("openrouterKey");
    if (!apiKey) throw new AccessError(503, "platform_unconfigured");
    const maxTokens = raw.max_tokens ?? raw.max_completion_tokens ?? 8192;
    if (!Number.isSafeInteger(maxTokens) || (maxTokens as number) < 1 || (raw.max_tokens != null && raw.max_completion_tokens != null && raw.max_tokens !== raw.max_completion_tokens)) throw new AccessError(400, "invalid_max_tokens", "Output token limit must be a positive safe integer; token limit fields must agree when both are supplied");
    // ponytail: estimate images as 8k input tokens, not their base64 bytes; use provider-specific counts if measured usage warrants it.
    const inputs = JSON.stringify({ messages: raw.messages, tools: raw.tools }, (_key, value) => value?.type === "image_url" || (typeof value === "string" && value.startsWith("data:image/")) ? " ".repeat(8192) : value);
    const reserve = Buffer.byteLength(inputs) * price.input + (maxTokens as number) * price.output;
    const call = this.store.admitModel(project, raw.model, reserve);
    const controller = new AbortController();
    const disconnected = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on("close", disconnected);
    let cost: number | null = null;
    let submitted = false;
    const readUsage = (usage: unknown) => {
      if (!usage || typeof usage !== "object") return;
      const value = usage as Record<string, unknown>;
      if (typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0) cost = value.cost;
      else if (typeof value.prompt_tokens === "number" && typeof value.completion_tokens === "number" && [value.prompt_tokens, value.completion_tokens].every(x => Number.isFinite(x) && x >= 0)) cost = value.prompt_tokens * price.input + value.completion_tokens * price.output;
    };
    try {
      const tokenField = raw.max_tokens != null || raw.max_completion_tokens == null ? "max_tokens" : "max_completion_tokens";
      const payload: Record<string, unknown> = { ...raw, [tokenField]: maxTokens, ...(raw.stream ? { stream_options: { include_usage: true } } : {}) };
      delete payload[tokenField === "max_tokens" ? "max_completion_tokens" : "max_tokens"];
      // Identity and credentials are supplied only by this service; caller headers are never forwarded.
      submitted = true;
      const response = await this.fetcher(this.upstream, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(payload), signal: controller.signal });
      if (!response.ok) {
        // Explicit upstream rejection before generation is not a billed success.
        if (response.status >= 400 && response.status < 500) cost = 0;
        const body = await response.text();
        return reply.code(response.status).type("application/json").send(body.replaceAll(apiKey, "[redacted]"));
      }
      if (!raw.stream) {
        const body = await response.json() as { usage?: unknown };
        readUsage(body.usage);
        return reply.send(body);
      }
      if (!response.body) throw new Error("Missing upstream stream");
      reply.hijack();
      reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
      const decoder = new TextDecoder();
      let pending = "";
      for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        if (pending.length > 8 * 1024 * 1024) throw new Error("Upstream SSE event too large");
        const lines = pending.split(/\r?\n/);
        pending = lines.pop()!;
        for (const line of lines) if (line.startsWith("data:")) {
          try { const event = JSON.parse(line.slice(5).trim()); readUsage(event.usage); } catch { /* [DONE] and non-usage frames pass through unchanged. */ }
        }
        if (!reply.raw.write(chunk)) await new Promise<void>((resolve, reject) => {
          const close = () => { cleanup(); reject(new Error("Client disconnected")); };
          const drain = () => { cleanup(); resolve(); };
          const cleanup = () => { reply.raw.off("close", close); reply.raw.off("drain", drain); };
          reply.raw.once("drain", drain); reply.raw.once("close", close);
        });
      }
      reply.raw.end();
    } catch (error) {
      if (!submitted) cost = 0;
      if (reply.raw.headersSent) reply.raw.destroy();
      else throw new AccessError(502, "platform_upstream_failed", "Platform model request failed");
    } finally {
      reply.raw.off("close", disconnected);
      this.store.settle(call, cost);
    }
  }
}

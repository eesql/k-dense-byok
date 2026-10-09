import { updateOpenRouterCatalogue } from "./models.ts";

/** Authenticated catalogue, filtered by OpenRouter's user preferences and key guardrails. */
export async function listOpenRouterModels(apiKey: string, endpoint = "https://openrouter.ai/api/v1/models/user", fetcher: typeof fetch = fetch) {
  const response = await fetcher(endpoint, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`OpenRouter model discovery returned HTTP ${response.status}`);
  const value = await response.json() as { data?: unknown };
  if (!Array.isArray(value.data)) throw new Error("OpenRouter returned an invalid model catalogue");
  const models = new Map<string, {
    id: string; label: string; provider: string; tier: "mid"; context_length: number;
    pricing: { prompt: number; completion: number }; modality: string; description: string;
    reasoning: boolean; sourceId: string; sourceLabel: string; billingMode: "payg"; available: boolean;
    max_completion_tokens: number;
  }>();
  for (const row of value.data) {
    if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id) continue;
    if (Array.isArray(row.architecture?.output_modalities) && !row.architecture.output_modalities.includes("text")) continue;
    if ([row.pricing?.prompt, row.pricing?.completion].some(price => (typeof price !== "string" && typeof price !== "number") || (typeof price === "string" && !price.trim()))) continue;
    const prompt = Number(row.pricing?.prompt), completion = Number(row.pricing?.completion);
    if (![prompt, completion].every(n => Number.isFinite(n) && n >= 0)) continue;
    const id = `openrouter/${row.id}`;
    models.set(id, {
      id, label: typeof row.name === "string" ? row.name : row.id,
      provider: row.id.split("/", 1)[0], tier: "mid",
      context_length: typeof row.context_length === "number" ? row.context_length : 0,
      max_completion_tokens: Number.isInteger(row.top_provider?.max_completion_tokens) && row.top_provider.max_completion_tokens > 0 ? row.top_provider.max_completion_tokens : 8192,
      pricing: { prompt: prompt * 1e6, completion: completion * 1e6 },
      modality: typeof row.architecture?.modality === "string" ? row.architecture.modality : "text->text",
      description: typeof row.description === "string" ? row.description : "OpenRouter",
      reasoning: Array.isArray(row.supported_parameters) && row.supported_parameters.includes("reasoning"),
      sourceId: "openrouter", sourceLabel: "OpenRouter", billingMode: "payg", available: true,
    });
  }
  const rows = [...models.values()];
  updateOpenRouterCatalogue(rows);
  return rows;
}

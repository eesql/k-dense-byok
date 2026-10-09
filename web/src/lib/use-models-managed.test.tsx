import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectScopeProvider } from "./projects";
import { useModels } from "./use-models";
import catalogue from "@/data/models.json";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("keeps discovery in its project scope and ignores a late BYOK reply after selecting platform supply", async () => {
  vi.stubEnv("NEXT_PUBLIC_KADY_MULTI_TENANT", "1");
  const json = (value: unknown) => new Response(JSON.stringify(value));
  let resolveOld!: (response: Response) => void;
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  const fetcher = vi.fn(async (url: string, options: RequestInit) => {
    const project = new Headers(options.headers).get("X-Project-Id");
    if (url.endsWith("/providers/models")) return project === "byok" ? old : json({ providers: [{ id: "google", configured: false }], models: [] });
    if (url.endsWith("/model-providers")) return json({ providers: [{ id: "openrouter", configured: true, connected: false, source: project === "platform" ? "Platform" : "API key" }] });
    if (url.endsWith("/credentials")) return json({ openrouter: { set: true } });
    if (url.endsWith("/model-providers/models")) return json({ models: [] });
    return json({ available: false, configured: false, models: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  let project = "byok";
  const { result, rerender } = renderHook(() => useModels(), { wrapper: ({ children }) => <ProjectScopeProvider value={project}>{children}</ProjectScopeProvider> });
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  project = "platform"; rerender();
  await waitFor(() => expect(result.current.providerStatuses[0]?.source).toBe("Platform"));
  await act(async () => { resolveOld(json({ providers: [{ id: "google", configured: true }], models: [] })); await old; });
  expect(result.current.configuredDirectProviders).toEqual([]);
  expect(result.current.isModelAvailable({ id: "google/test" })).toBe(false);
  expect(fetcher.mock.calls.some(([, options]) => new Headers(options.headers).get("X-Project-Id") === "platform")).toBe(true);
});

it("lists only the key's allowed OpenRouter models once and refuses stale restricted selections", async () => {
  vi.stubEnv("NEXT_PUBLIC_KADY_MULTI_TENANT", "1");
  const allowed = catalogue.filter(model => !model.isFusion).slice(0, 2);
  const denied = catalogue.filter(model => !model.isFusion)[2];
  const json = (value: unknown) => new Response(JSON.stringify(value));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/openrouter/models")) return json({ configured: true, models: [...allowed, allowed[0]] });
    if (url.endsWith("/providers/models")) return json({ providers: [{ id: "openrouter", configured: true }], models: catalogue });
    if (url.endsWith("/model-providers")) return json({ providers: [{ id: "openrouter", configured: true, connected: false }] });
    if (url.endsWith("/credentials")) return json({ openrouter: { set: true } });
    return json({ models: [], providers: [], available: false });
  }));
  const { result } = renderHook(() => useModels(), { wrapper: ({ children }) => <ProjectScopeProvider value="restricted-key">{children}</ProjectScopeProvider> });
  await waitFor(() => expect(result.current.isModelAvailable(allowed[0])).toBe(true));
  expect(result.current.models.filter(model => model.id.startsWith("openrouter/")).map(model => model.id)).toEqual(allowed.map(model => model.id));
  expect(new Set(result.current.models.map(model => model.id)).size).toBe(result.current.models.length);
  expect(result.current.isModelAvailable(denied)).toBe(false);
  expect(result.current.models.filter(model => model.isFusion)).toEqual([]);
});

it("does not fall back to the full catalogue when restricted discovery fails, and retries on auth changes", async () => {
  vi.stubEnv("NEXT_PUBLIC_KADY_MULTI_TENANT", "1");
  const allowed = catalogue[0];
  const json = (value: unknown) => new Response(JSON.stringify(value));
  let failed = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/openrouter/models")) return failed ? new Response("{}", { status: 502 }) : json({ configured: true, models: [allowed] });
    if (url.endsWith("/model-providers")) return json({ providers: [{ id: "openrouter", configured: true, connected: false }] });
    if (url.endsWith("/credentials")) return json({ openrouter: { set: true } });
    return json({ models: [], providers: [], available: false });
  }));
  const { result } = renderHook(() => useModels(), { wrapper: ({ children }) => <ProjectScopeProvider value="failed-key-discovery">{children}</ProjectScopeProvider> });
  await waitFor(() => expect(result.current.openrouterError).toBeTruthy());
  expect(result.current.models.filter(model => model.id.startsWith("openrouter/") || model.isFusion)).toEqual([]);
  expect(result.current.isModelAvailable(allowed)).toBe(false);
  failed = false;
  await act(async () => { window.dispatchEvent(new Event("kady:provider-auth-changed")); });
  await waitFor(() => expect(result.current.isModelAvailable(allowed)).toBe(true));
  expect(result.current.openrouterError).toBeNull();
});

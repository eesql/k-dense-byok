import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ManagedShell, TeamManagementPage } from "./multitenant-shell";
import { activateManagedIdentity, clearManagedIdentity, managedStorageKey } from "@/lib/managed-storage";

const projectHookState = vi.hoisted(() => ({ loading: false }));
vi.mock("@/lib/use-projects", () => ({
  ProjectProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useProjects: () => ({ projects: [{ id: "project-a" }], refresh: vi.fn(), loading: projectHookState.loading, setActive: vi.fn() }),
}));
beforeEach(() => { projectHookState.loading = false; window.localStorage.clear(); window.history.replaceState(null, "", "/"); clearManagedIdentity(); vi.stubEnv("NEXT_PUBLIC_KADY_MULTI_TENANT", "1"); });
afterEach(() => { clearManagedIdentity(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("holds the research workspace behind login and sends credentials only to the login API", async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ reason: "login_required" }), { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: "user-a", username: "researcher", role: "member", tenantId: "lab-a" } })));
  vi.stubGlobal("fetch", fetcher);
  render(<ManagedShell><div>Research workspace</div></ManagedShell>);
  expect(screen.queryByText("Research workspace")).not.toBeInTheDocument();
  const username = await screen.findByLabelText("Username");
  fireEvent.change(username, { target: { value: "researcher" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "test-user-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText("Research workspace");
  expect(fetcher.mock.calls[1][0]).toContain("/management/login");
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ username: "researcher", password: "test-user-password" });
  expect(window.localStorage.getItem("kady:managed:identity")).toBe("user-a:lab-a");
  expect(window.localStorage.getItem("kady:apiToken")).toBeNull();
});

it("partitions persisted research state by account and leaves single-user keys unchanged when off", () => {
  activateManagedIdentity({ id: "alice", tenantId: "lab-a" });
  const alice = managedStorageKey("kady:workspace:v1");
  window.localStorage.setItem(alice, "alice workspace");
  activateManagedIdentity({ id: "bob", tenantId: "lab-b" });
  expect(managedStorageKey("kady:workspace:v1")).not.toBe(alice);
  expect(window.localStorage.getItem(managedStorageKey("kady:workspace:v1"))).toBeNull();
  vi.stubEnv("NEXT_PUBLIC_KADY_MULTI_TENANT", "0");
  expect(managedStorageKey("kady:workspace:v1")).toBe("kady:workspace:v1");
});

function managementFixture() {
  const tenants = ["alpha", "bravo"].map(id => ({ id, name: id === "alpha" ? "Alpha lab" : "Bravo lab", enabled: 1, budgetUsd: 10, taskLimit: 5, modelLimit: 5, usage: { spentUsd: 0.1, reservedUsd: 0, unsettled: 0 } }));
  const projects = tenants.map(team => ({ id: "project-" + team.id, tenantId: team.id, name: team.name + " study", supply: "platform", pendingCredentials: false }));
  const mutations: { path: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    const path = new URL(url, "http://localhost").pathname;
    const body = options?.body ? JSON.parse(String(options.body)) : {};
    if (options?.method && options.method !== "GET") {
      mutations.push({ path, body });
      if (path.endsWith("/projects") && options.method === "POST") {
        const project = { id: "new-project", name: String(body.name), tenantId: String(body.tenantId), supply: String(body.supply), pendingCredentials: false };
        projects.push(project);
        return Response.json(project);
      }
      if (path.includes("/projects/")) {
        const project = projects.find(project => path.endsWith("/" + project.id))!;
        Object.assign(project, body); return Response.json(project);
      }
      return Response.json({ ok: true });
    }
    if (path.endsWith("/management/tenants")) return Response.json({ tenants });
    if (path.endsWith("/projects")) return Response.json(projects);
    if (path.endsWith("/management/platform")) return Response.json({ configured: true });
    if (path.endsWith("/management/usage")) return Response.json({ projects: [] });
    if (path.endsWith("/management/calls")) return Response.json({ calls: [] });
    if (path.endsWith("/members")) return Response.json({ members: [{ id: "member-" + path.split("/").at(-2), username: path.includes("/bravo/") ? "Bravo researcher" : "Alpha researcher", role: "member", enabled: 1 }] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetcher);
  const onOpenProject = vi.fn(), onChange = vi.fn(async () => {});
  const user = { id: "admin", username: "administrator", role: "admin" as const, tenantId: null };
  render(<TeamManagementPage user={user} activeProjectId="project-bravo" onChange={onChange} onOpenProject={onOpenProject} />);
  return { fetcher, mutations, onOpenProject };
}

it("starts on the active project's team and applies model access only after an explicit save", async () => {
  const { mutations, onOpenProject } = managementFixture();
  await screen.findByText("Bravo lab study");
  expect(screen.getByLabelText("Team")).toHaveValue("bravo");
  expect(screen.queryByText("Alpha lab study")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Model access for Bravo lab study" }));
  fireEvent.click(screen.getByRole("radio", { name: /Team credentials/ }));
  expect(mutations).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Apply access change" }));
  await screen.findByText("Project model access updated.");
  expect(mutations).toEqual([{ path: expect.stringContaining("/projects/project-bravo"), body: { supply: "byok" } }]);
  fireEvent.click(screen.getByRole("button", { name: "Configure team providers" }));
  expect(onOpenProject).toHaveBeenCalledWith("project-bravo", true);
});

it("requires an explicit source when creating a project and keeps configuration open after creation", async () => {
  const { mutations, onOpenProject } = managementFixture();
  await screen.findByText("Bravo lab study");
  fireEvent.click(screen.getByRole("button", { name: "New project" }));
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "New experiment" } });
  expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
  fireEvent.click(screen.getByRole("radio", { name: /Platform access/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await screen.findByText("New experiment");
  expect(mutations[0]).toEqual({ path: expect.stringContaining("/projects"), body: { name: "New experiment", supply: "platform", tenantId: "bravo" } });
  expect(onOpenProject).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open project New experiment" }));
  expect(onOpenProject).toHaveBeenCalledWith("new-project");
});

it("separates the platform Key from team limits and loads the selected team's members", async () => {
  const { mutations } = managementFixture();
  await screen.findByText("Bravo lab study");
  fireEvent.click(screen.getByRole("button", { name: "Platform access" }));
  expect(screen.getByText(/across all teams/)).toBeInTheDocument();
  expect(screen.getByLabelText("Platform OpenRouter Key")).toBeInTheDocument();
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Usage & limits" }));
  expect(screen.queryByLabelText("Platform OpenRouter Key")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("spinbutton", { name: /Cumulative platform budget/ }), { target: { value: "25" } });
  fireEvent.click(screen.getByRole("button", { name: "Save team limits" }));
  await screen.findByText(/Team limits saved/);
  expect(mutations[0]).toEqual({ path: expect.stringContaining("/management/tenants/bravo"), body: { budgetUsd: 25, taskLimit: 5, modelLimit: 5 } });
  fireEvent.click(screen.getByRole("button", { name: "Members" }));
  await screen.findByText("Bravo researcher");
  fireEvent.change(screen.getByLabelText("Team"), { target: { value: "alpha" } });
  await screen.findByText("Alpha researcher");
  expect(screen.queryByText("Bravo researcher")).not.toBeInTheDocument();
});

it("keeps research mounted during management and project refresh, and hides privileged controls from members", async () => {
  const unmounted = vi.fn();
  function Research() {
    useEffect(() => () => unmounted(), []);
    return <div data-testid="research">Research workspace</div>;
  }
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/management/me")) return Response.json({ user: { id: "member", username: "researcher", role: "member", tenantId: "lab" } });
    if (url.endsWith("/management/tenants")) return Response.json({ tenants: [{ id: "lab", name: "Team lab", enabled: 1, budgetUsd: 10, taskLimit: 5, modelLimit: 5, usage: { spentUsd: 0, reservedUsd: 0, unsettled: 0 } }] });
    if (url.endsWith("/projects")) return Response.json([{ id: "project-a", tenantId: "lab", name: "Study", supply: "byok" }]);
    if (url.endsWith("/management/calls")) return Response.json({ calls: [] });
    return Response.json({ projects: [] });
  }));
  const { rerender } = render(<ManagedShell><Research /></ManagedShell>);
  await screen.findByText("Research workspace");
  fireEvent.click(screen.getByRole("button", { name: "Team settings" }));
  await screen.findByText("Study");
  expect(screen.getByTestId("research")).not.toBeVisible();
  expect(screen.queryByRole("button", { name: "Platform access" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Members" })).not.toBeInTheDocument();
  projectHookState.loading = true;
  rerender(<ManagedShell><Research /></ManagedShell>);
  expect(unmounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));
  expect(screen.getByTestId("research")).toBeVisible();
  expect(unmounted).not.toHaveBeenCalled();
});

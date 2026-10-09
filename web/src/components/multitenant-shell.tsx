"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeftIcon, FolderIcon, UsersIcon, GaugeIcon, KeyIcon, PlusIcon, ArrowUpRightIcon, CheckIcon } from "lucide-react";
import { SettingsError, SettingsNotice } from "@/components/settings/primitives";
import { cn } from "@/lib/utils";
import { ProjectProvider, useProjects } from "@/lib/use-projects";
import { API_BASE, type Project } from "@/lib/projects";
import { activateManagedIdentity, clearManagedIdentity, managedIdentityKey } from "@/lib/managed-storage";
import { PROVIDER_AUTH_CHANGED_EVENT } from "@/lib/use-provider-auth";

interface User { id: string; username: string; role: "admin" | "owner" | "member"; tenantId: string | null }
interface Tenant { id: string; name: string; enabled: number; budgetUsd: number | null; taskLimit: number; modelLimit: number; usage: { spentUsd: number; reservedUsd: number; unsettled: number } }
interface Member { id: string; username: string; role: string; enabled: number }
interface Call { id: string; model: string; projectId: string; tenantId: string; state: string; cost: number | null; reserved: number }
interface ProjectUsage { projectId: string; tenantId: string; name: string; spentUsd: number; reservedUsd: number; unsettled: number }
interface ManagedProject extends Project { tenantId: string; supply: "byok" | "platform"; pendingCredentials: boolean }
async function managedRequest<T>(route: string, method = "GET", body?: unknown): Promise<T> {
  const identity = managedIdentityKey(), headers = new Headers(body === undefined ? undefined : { "Content-Type": "application/json" });
  if (identity && !["/management/me", "/management/login", "/management/join"].includes(route)) headers.set("X-Kady-User", identity.split(":")[0]);
  const response = await fetch(`${API_BASE}${route}`, { method, credentials: "same-origin", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (identity !== managedIdentityKey()) throw new DOMException("Account changed", "AbortError");
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.detail || value.reason || `Request failed (${response.status})`), { status: response.status });
  if (route === "/management/platform" && method === "PUT" || route.startsWith("/projects/") && method === "PATCH" && (body as { supply?: string } | undefined)?.supply) window.dispatchEvent(new Event(PROVIDER_AUTH_CHANGED_EVENT));
  return value as T;
}
const field = "grid gap-1 text-sm";
const selectStyle = "h-9 rounded-md border bg-background px-2 text-sm";

export function ManagedShell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null), [loading, setLoading] = useState(true);
  const [username, setUsername] = useState(""), [password, setPassword] = useState(""), [invite, setInvite] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const captureInvite = () => {
      const invitation = new URLSearchParams(window.location.hash.slice(1)).get("invite");
      if (invitation) {
        setInvite(invitation); try { sessionStorage.setItem("kady:pending-invite", invitation); } catch {}
        window.history.replaceState(null, "", window.location.pathname);
      } else { try { setInvite(sessionStorage.getItem("kady:pending-invite") ?? ""); } catch {} }
    };
    captureInvite(); window.addEventListener("hashchange", captureInvite);
    void managedRequest<{ user: User }>("/management/me").then(value => {
      if (active) { activateManagedIdentity(value.user); setUser(value.user); }
    }).catch(() => { if (active) clearManagedIdentity(); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; window.removeEventListener("hashchange", captureInvite); };
  }, []);
  const login = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      if (invite) {
        await managedRequest("/management/join", "POST", { token: invite, username, password });
        setInvite(""); try { sessionStorage.removeItem("kady:pending-invite"); } catch {}
      }
      const value = await managedRequest<{ user: User }>("/management/login", "POST", { username, password });
      activateManagedIdentity(value.user); setPassword(""); setUser(value.user);
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const logout = async () => {
    try { await managedRequest("/management/logout", "POST", {}); clearManagedIdentity(); window.location.reload(); }
    catch (failure) { setError((failure as Error).message); }
  };
  if (loading) return <main className="grid min-h-screen place-items-center" aria-busy="true">Loading workspace…</main>;
  if (!user) return <main className="grid min-h-screen place-items-center p-6"><section className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-6">
    <div><h1 className="text-xl font-semibold">{invite ? "Join your Kady team" : "Sign in to Kady"}</h1><p className="mt-2 text-sm text-muted-foreground">An internal workspace for trusted research teams.</p></div>
    <form onSubmit={login} className="space-y-4">
      <label className={field}>Username<Input autoComplete="username" required minLength={3} maxLength={80} value={username} onChange={e => setUsername(e.target.value)} /></label>
      <label className={field}>Password<Input type="password" autoComplete={invite ? "new-password" : "current-password"} required minLength={invite ? 12 : 1} maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} /></label>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Button className="w-full" disabled={busy}>{busy ? "Please wait…" : invite ? "Join and sign in" : "Sign in"}</Button>
    </form>
  </section></main>;
  return <ProjectProvider key={`${user.id}:${user.tenantId}`}><ManagedWorkspace user={user} logout={logout}>{children}</ManagedWorkspace></ProjectProvider>;
}

const roleName = { admin: "Platform admin", owner: "Team owner", member: "Member" };
type Supply = "byok" | "platform";
type ManagementSection = "projects" | "members" | "usage" | "platform";
const usd = (value: number) => "$" + value.toFixed(4);

function ManagedWorkspace({ user, logout, children }: { user: User; logout: () => Promise<void>; children: ReactNode }) {
  const { projects, activeProjectId, refresh, loading, error: projectsError, setActive } = useProjects();
  const [open, setOpen] = useState(false), [error, setError] = useState("");
  const openManagement = useCallback(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("manage") !== "team") {
      url.searchParams.set("manage", "team");
      window.history.pushState(null, "", url);
    }
    setOpen(true);
  }, []);
  const closeManagement = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("manage");
    window.history.replaceState(null, "", url);
    setOpen(false);
  };
  useEffect(() => {
    const syncLocation = () => setOpen(new URL(window.location.href).searchParams.get("manage") === "team");
    syncLocation();
    window.addEventListener("popstate", syncLocation);
    window.addEventListener("kady:open-team-management", openManagement);
    return () => {
      window.removeEventListener("popstate", syncLocation);
      window.removeEventListener("kady:open-team-management", openManagement);
    };
  }, [openManagement]);
  useEffect(() => {
    const expired = () => { clearManagedIdentity(); window.location.reload(); };
    window.addEventListener("kady:managed-session-expired", expired);
    const timer = setInterval(() => {
      void managedRequest<{ user: User }>("/management/me").then(value => {
        if (value.user.id !== user.id || value.user.tenantId !== user.tenantId) expired();
      }).catch(failure => {
        if (failure.status === 401) expired();
        else setError("Could not confirm session status; retry when the server is available.");
      });
    }, 15000);
    return () => { clearInterval(timer); window.removeEventListener("kady:managed-session-expired", expired); };
  }, [user.id, user.tenantId]);
  const openProject = (id: string, providers = false) => {
    setActive(id);
    window.dispatchEvent(new CustomEvent("kady:open-project", { detail: { projectId: id, providers } }));
    closeManagement();
  };
  return <div className="flex h-dvh flex-col">
    <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2 text-sm">
      {open ? <Button size="sm" variant="ghost" onClick={closeManagement}><ArrowLeftIcon />Back to workspace</Button> : <span className="truncate">{user.username} <span className="text-muted-foreground">· {roleName[user.role]}</span></span>}
      <div className="flex shrink-0 items-center gap-2">
        {open ? <span className="hidden text-xs text-muted-foreground sm:inline">{user.username} · {roleName[user.role]}</span> : <Button size="sm" variant="outline" onClick={openManagement}>Team settings</Button>}
        <Button size="sm" variant="ghost" onClick={() => void logout()}>Sign out</Button>
      </div>
    </header>
    {error ? <SettingsError className="m-3">{error}</SettingsError> : null}
    <div hidden={open} aria-hidden={open} className={cn("min-h-0 flex-1 [&>.contents>div]:h-full [&>.contents>div]:min-h-0", open && "hidden")}>
      {loading && !projects.length ? <p className="p-6" role="status">Loading projects…</p> : projects.length ? children : <div className="mx-auto max-w-lg px-6 py-16">
        <h1 className="text-2xl font-semibold">Your team workspace</h1>
        <p className="mb-6 mt-2 text-sm text-muted-foreground">Create a research project and choose who provides its model access.</p>
        {projectsError ? <SettingsError>{projectsError}</SettingsError> : null}
        <Button onClick={openManagement}><PlusIcon />Create a project</Button>
      </div>}
    </div>
    {open ? <TeamManagementPage user={user} activeProjectId={activeProjectId} onChange={refresh} onOpenProject={openProject} /> : null}
  </div>;
}

function SupplyOptions({ name, value, onChange, disabled }: { name: string; value: Supply | null; onChange: (value: Supply) => void; disabled?: boolean }) {
  return <fieldset disabled={disabled} className="min-w-0 space-y-2">
    <legend className="mb-2 text-sm font-medium">Who provides model access?</legend>
    {([
      ["platform", "Platform access", "Uses the platform OpenRouter Key and this team's platform budget."],
      ["byok", "Team credentials (BYOK)", "Uses this team's shared provider API keys or sign-ins. Platform budget is not charged."],
    ] as const).map(([id, title, description]) => <label key={id} className={cn(
      "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40 focus-within:ring-2 focus-within:ring-ring",
      value === id && "border-foreground/40 bg-muted/40",
      disabled && "cursor-not-allowed opacity-60",
    )}>
      <input type="radio" name={name} value={id} checked={value === id} onChange={() => onChange(id)} className="mt-1 shrink-0 accent-primary" />
      <span className="min-w-0"><span className="block text-sm font-medium">{title}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{description}</span></span>
    </label>)}
  </fieldset>;
}

/** Team-scoped administration; platform credentials deliberately have their own global section. */
export function TeamManagementPage({ user, activeProjectId, onChange, onOpenProject }: {
  user: User; activeProjectId: string; onChange: () => Promise<void>; onOpenProject: (id: string, providers?: boolean) => void;
}) {
  const [tenants, setTenants] = useState<Tenant[]>([]), [selected, setSelected] = useState(user.tenantId ?? "");
  const [projects, setProjects] = useState<ManagedProject[]>([]), [members, setMembers] = useState<Member[]>([]), [calls, setCalls] = useState<Call[]>([]);
  const [usage, setUsage] = useState<ProjectUsage[]>([]), [configured, setConfigured] = useState(false);
  const [section, setSection] = useState<ManagementSection>("projects");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [creatingTeam, setCreatingTeam] = useState(false), [name, setName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false), [projectName, setProjectName] = useState(""), [source, setSource] = useState<Supply | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null), [draftSupply, setDraftSupply] = useState<Supply>("byok");
  const [invite, setInvite] = useState(""), [role, setRole] = useState("member"), [platformKey, setPlatformKey] = useState("");
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    try {
      const [teams, work, ledger, totals, platform] = await Promise.all([
        managedRequest<{ tenants: Tenant[] }>("/management/tenants"),
        managedRequest<ManagedProject[]>("/projects"),
        managedRequest<{ calls: Call[] }>("/management/calls"),
        managedRequest<{ projects: ProjectUsage[] }>("/management/usage"),
        user.role === "admin" ? managedRequest<{ configured: boolean }>("/management/platform") : Promise.resolve(null),
      ]);
      const teamId = selected || user.tenantId || work.find(project => project.id === activeProjectId)?.tenantId || teams.tenants[0]?.id || "";
      const people = teamId && user.role !== "member" ? await managedRequest<{ members: Member[] }>("/management/tenants/" + teamId + "/members") : { members: [] };
      if (request !== sequence.current) return;
      setTenants(teams.tenants); setProjects(work); setCalls(ledger.calls); setUsage(totals.projects); setMembers(people.members);
      if (!selected && teamId) setSelected(teamId);
      if (platform) setConfigured(platform.configured);
    } finally { if (request === sequence.current) setLoading(false); }
  }, [selected, user.role, user.tenantId, activeProjectId]);
  useEffect(() => {
    let active = true;
    void load().catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; sequence.current++; };
  }, [load]);
  const action = async (work: () => Promise<unknown>, message: string) => {
    setBusy(true); setError(""); setNotice("");
    try { await work(); await load(); await onChange(); setNotice(message); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  };
  const team = tenants.find(tenant => tenant.id === selected);
  const teamProjects = projects.filter(project => project.tenantId === selected);
  const project = teamProjects.find(project => project.id === editingId);
  const teamUsage = usage.filter(row => row.tenantId === selected);
  const unsettled = calls.filter(call => call.tenantId === selected && call.state === "unsettled");
  const navigation = [
    { id: "projects" as const, label: "Projects", icon: FolderIcon },
    ...(user.role !== "member" ? [{ id: "members" as const, label: "Members", icon: UsersIcon }] : []),
    { id: "usage" as const, label: "Usage & limits", icon: GaugeIcon },
    ...(user.role === "admin" ? [{ id: "platform" as const, label: "Platform access", icon: KeyIcon }] : []),
  ];
  const navigate = (next: ManagementSection) => { setSection(next); setCreatingTeam(false); setError(""); setNotice(""); };
  const selectTeam = (id: string) => {
    sequence.current++; setLoading(true); setMembers([]);
    setSelected(id); setInvite(""); setEditingId(null); setCreatingProject(false); setError(""); setNotice("");
  };
  return <main className="min-h-0 flex-1 overflow-y-auto" aria-label="Team management">
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col md:flex-row">
      <aside className="shrink-0 border-b bg-muted/20 px-4 py-5 md:w-56 md:border-b-0 md:border-r md:px-5 md:py-7">
        <h1 className="text-lg font-semibold">Team settings</h1>
        <div className="mb-5 mt-5 space-y-2">
          <label className={field}>Team
            <select className={selectStyle + " w-full"} value={selected} disabled={busy || loading || !tenants.length} onChange={e => selectTeam(e.target.value)}>
              {!tenants.length ? <option value="">No teams yet</option> : tenants.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name}{tenant.enabled ? "" : " (disabled)"}</option>)}
            </select>
          </label>
          {user.role === "admin" ? <Button size="sm" variant="ghost" className="-ml-2" disabled={busy} onClick={() => { setCreatingTeam(true); setError(""); setNotice(""); }}><PlusIcon />New team</Button> : null}
        </div>
        <nav aria-label="Team settings sections" className="flex flex-wrap gap-1 md:flex-col">
          {navigation.map(({ id, label, icon: Icon }) => <Button key={id} variant={section === id && !creatingTeam ? "secondary" : "ghost"} size="sm" disabled={busy} aria-current={section === id && !creatingTeam ? "page" : undefined} className="justify-start md:w-full" onClick={() => navigate(id)}><Icon className="size-4" />{label}</Button>)}
        </nav>
        <p className="mt-6 hidden text-xs leading-relaxed text-muted-foreground md:block">Projects, files and team credentials are shared with your team.</p>
      </aside>
      <div className="min-w-0 flex-1 px-5 py-6 sm:px-8 md:py-8">
        {error ? <div className="mb-5"><SettingsError>{error}</SettingsError><Button className="mt-2" variant="ghost" size="sm" onClick={() => { setError(""); void load().catch(failure => setError(failure.message)); }}>Reload settings</Button></div> : null}
        {notice ? <SettingsNotice className="mb-5">{notice}</SettingsNotice> : null}
        {loading ? <div role="status" aria-label="Loading team settings" className="space-y-4"><div className="h-7 w-48 animate-pulse rounded bg-muted" /><div className="h-4 w-72 max-w-full animate-pulse rounded bg-muted" /><div className="h-28 animate-pulse rounded bg-muted" /></div> : creatingTeam ? <>
          <h2 className="text-xl font-semibold">Create a team</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">A team owns shared research projects, members and BYOK credentials.</p>
          <form className="mt-6 max-w-md space-y-4" onSubmit={e => { e.preventDefault(); void action(async () => {
            const added = await managedRequest<Tenant>("/management/tenants", "POST", { name: name.trim() });
            selectTeam(added.id); setName(""); setCreatingTeam(false); setSection("members");
          }, "Team created. Invite a team owner to manage its members."); }}>
            <label className={field}>Team name<Input required maxLength={200} value={name} onChange={e => setName(e.target.value)} autoFocus /></label>
            <div className="flex gap-2"><Button disabled={busy || !name.trim()}>Create team</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setCreatingTeam(false)}>Cancel</Button></div>
          </form>
        </> : section === "platform" ? <>
          <h2 className="text-xl font-semibold">Platform model access</h2>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">One OpenRouter Key supplies every project that chooses platform access, across all teams. Team BYOK credentials are configured separately.</p>
          <div className="mt-6 flex items-center gap-2 text-sm"><KeyIcon className="size-4 text-muted-foreground" /><span>{configured ? "Platform Key saved" : "No platform Key saved"}</span>{configured ? <CheckIcon className="size-4 text-emerald-600" aria-hidden /> : null}</div>
          <form className="mt-4 max-w-xl space-y-4" onSubmit={e => { e.preventDefault(); void action(async () => {
            await managedRequest("/management/platform", "PUT", { apiKey: platformKey }); setPlatformKey("");
          }, "Platform Key saved. Platform projects will discover the models permitted by this Key."); }}>
            <label className={field}>Platform OpenRouter Key<Input type="password" autoComplete="off" required minLength={8} value={platformKey} placeholder={configured ? "Enter a replacement Key" : "Enter an OpenRouter Key"} onChange={e => setPlatformKey(e.target.value)} /></label>
            <p className="text-xs leading-relaxed text-muted-foreground">The Key is stored by the platform. Team members receive model access, not the Key itself.</p>
            <Button disabled={busy}>{configured ? "Replace platform Key" : "Save platform Key"}</Button>
          </form>
          <div className="mt-8 border-t pt-5 text-xs leading-relaxed text-muted-foreground">This deployment is for trusted internal users. Local shell execution has no OS isolation.</div>
        </> : !team ? <>
          <h2 className="text-xl font-semibold">Start with a team</h2>
          <p className="my-3 max-w-prose text-sm text-muted-foreground">Create a team before adding shared projects or inviting members.</p>
          {user.role === "admin" ? <Button onClick={() => setCreatingTeam(true)}><PlusIcon />Create team</Button> : null}
        </> : section === "projects" ? project ? <>
          <Button size="sm" variant="ghost" className="-ml-2 mb-4" disabled={busy} onClick={() => { setEditingId(null); setError(""); setNotice(""); }}><ArrowLeftIcon />All projects</Button>
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><h2 className="break-words text-xl font-semibold">{project.name}</h2><p className="mt-1 text-sm text-muted-foreground">Model access for this project in {team.name}.</p></div><Button variant="outline" size="sm" onClick={() => onOpenProject(project.id)}><ArrowUpRightIcon />Open project</Button></div>
          <form className="mt-6 max-w-xl space-y-4" onSubmit={e => { e.preventDefault(); void action(async () => {
            await managedRequest("/projects/" + project.id, "PATCH", { supply: draftSupply });
          }, "Project model access updated."); }}>
            <SupplyOptions name={"supply-" + project.id} value={draftSupply} onChange={setDraftSupply} disabled={busy || project.pendingCredentials} />
            <p className="text-xs leading-relaxed text-muted-foreground">Choose individual models in the chat model picker. Switching access requires an idle project and paused schedules; files and history stay in place.</p>
            {project.pendingCredentials ? <SettingsNotice>Credentials are waiting for active work to finish. New model tasks are blocked until reload completes.</SettingsNotice> : null}
            {user.role === "admin" && draftSupply === "platform" && !configured ? <SettingsNotice>No platform Key is saved. <button type="button" className="font-medium underline underline-offset-4" onClick={() => navigate("platform")}>Set up platform access</button> before running this project.</SettingsNotice> : null}
            <div className="flex flex-wrap items-center gap-3"><Button disabled={busy || project.pendingCredentials || draftSupply === project.supply}>Apply access change</Button><span className="text-xs text-muted-foreground">Current: {project.supply === "platform" ? "Platform access" : "Team credentials (BYOK)"}</span></div>
          </form>
          {project.supply === "byok" ? <div className="mt-8 max-w-xl border-t pt-5"><h3 className="text-sm font-medium">Team provider credentials</h3><p className="mb-4 mt-2 text-sm leading-relaxed text-muted-foreground">Configure API keys and provider sign-ins in Settings → Providers. These credentials are shared by all BYOK projects in {team.name}.</p><Button variant="outline" onClick={() => onOpenProject(project.id, true)}>Configure team providers<ArrowUpRightIcon /></Button></div> : null}
        </> : <>
          <div className="flex items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">Projects</h2><p className="mt-2 text-sm text-muted-foreground">Research workspaces shared by {team.name}.</p></div>{!creatingProject ? <Button size="sm" disabled={busy || !team.enabled} onClick={() => { setCreatingProject(true); setProjectName(""); setSource(null); setNotice(""); }}><PlusIcon />New project</Button> : null}</div>
          {creatingProject ? <form className="my-6 max-w-xl space-y-4 border-y py-5" onSubmit={e => { e.preventDefault(); if (!source) return; void action(async () => {
            await managedRequest<ManagedProject>("/projects", "POST", { name: projectName.trim(), supply: source, ...(user.role === "admin" ? { tenantId: team.id } : {}) });
            setCreatingProject(false); setProjectName(""); setSource(null);
          }, "Project created. Review its model access, then open the workspace."); }}>
            <h3 className="text-sm font-medium">New project in {team.name}</h3>
            <label className={field}>Project name<Input required maxLength={200} value={projectName} onChange={e => setProjectName(e.target.value)} autoFocus /></label>
            <SupplyOptions name="new-project-supply" value={source} onChange={setSource} disabled={busy} />
            <div className="flex gap-2"><Button disabled={busy || !source || !projectName.trim()}>Create project</Button><Button type="button" variant="ghost" disabled={busy} onClick={() => setCreatingProject(false)}>Cancel</Button></div>
          </form> : null}
          <div className="mt-6 divide-y border-y">
            {teamProjects.length ? teamProjects.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{item.name}</p><p className="mt-1 text-xs text-muted-foreground">{item.supply === "platform" ? "Platform access · team platform budget" : "Team credentials (BYOK)"}{item.pendingCredentials ? " · credentials pending reload" : ""}</p></div>
              <div className="flex shrink-0 gap-2"><Button size="sm" variant="ghost" disabled={busy} aria-label={"Model access for " + item.name} onClick={() => { setEditingId(item.id); setDraftSupply(item.supply); setError(""); setNotice(""); }}>Model access</Button><Button size="sm" variant="outline" disabled={busy} aria-label={"Open project " + item.name} onClick={() => onOpenProject(item.id)}>Open<ArrowUpRightIcon /></Button></div>
            </div>) : <div className="py-8 text-sm text-muted-foreground">No projects yet. Create one and explicitly choose its model access.</div>}
          </div>
        </> : section === "members" ? <>
          <h2 className="text-xl font-semibold">Members</h2><p className="mt-2 text-sm text-muted-foreground">Members of {team.name} share its projects, files and BYOK credentials.</p>
          <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); void action(async () => {
            const result = await managedRequest<{ token: string }>("/management/tenants/" + selected + "/invites", "POST", { role });
            setInvite(window.location.origin + "/#invite=" + result.token);
          }, "Invite created. It expires in one day and can be used once."); }}>
            <label className={field}>Invite as<select className={selectStyle} value={role} disabled={busy} onChange={e => setRole(e.target.value)}><option value="member">Member</option><option value="owner">Team owner</option></select></label>
            <Button disabled={busy}>Create invite</Button>
          </form>
          {invite ? <div className="mt-4 flex flex-wrap items-end gap-2"><label className={field + " min-w-0 flex-1"}>One-time invite link<Input readOnly value={invite} onFocus={e => e.target.select()} /></label><Button variant="outline" onClick={async () => { try { await navigator.clipboard.writeText(invite); setNotice("Invite link copied."); } catch { setError("Copy failed. Select the invite link and copy it manually."); } }}>Copy link</Button></div> : null}
          <ul className="mt-6 divide-y border-y">{members.length ? members.map(member => <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><span className="text-sm font-medium">{member.username}</span><p className="mt-1 text-xs text-muted-foreground">{roleName[member.role as keyof typeof roleName] ?? member.role}{member.enabled ? "" : " · access removed"}</p></div>{member.id !== user.id && member.enabled ? <Button variant="ghost" size="sm" className="text-destructive" disabled={busy} onClick={() => {
            if (window.confirm("Remove " + member.username + "'s access? Shared research tasks will continue.")) void action(() => managedRequest("/management/users/" + member.id, "DELETE"), "Member access removed. Shared research tasks continue.");
          }}>Remove access</Button> : null}</li>) : <li className="py-6 text-sm text-muted-foreground">No members yet. Invite a team owner or member to get started.</li>}</ul>
        </> : <>
          <h2 className="text-xl font-semibold">Usage & limits</h2><p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">Platform model usage for {team.name}. BYOK models and external compute do not consume this platform budget.</p>
          <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-3 border-y py-4 text-sm">{[["Spent", usd(team.usage.spentUsd)], ["Reserved", usd(team.usage.reservedUsd)], ["Unsettled calls", String(team.usage.unsettled)]].map(([label, value]) => <div key={label} className="flex items-baseline gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium tabular-nums">{value}</dd></div>)}</dl>
          {user.role === "admin" ? <form key={team.id + ":" + team.budgetUsd + ":" + team.taskLimit + ":" + team.modelLimit} className="mt-6 max-w-xl space-y-5" onSubmit={e => {
            e.preventDefault(); const form = new FormData(e.currentTarget);
            void action(() => managedRequest("/management/tenants/" + team.id, "PATCH", {
              budgetUsd: form.get("budget") === "" ? null : Number(form.get("budget")), taskLimit: Number(form.get("tasks")), modelLimit: Number(form.get("models")),
            }), "Team limits saved. Existing usage has been retained.");
          }}>
            <label className={field}>Cumulative platform budget (USD)<Input name="budget" type="number" min="0" step="0.01" defaultValue={team.budgetUsd ?? ""} placeholder="Unlimited" /><span className="text-xs leading-relaxed text-muted-foreground">Leave empty for unlimited. This is a cumulative budget, with no monthly reset.</span></label>
            <div className="grid gap-4 sm:grid-cols-2"><label className={field}>Concurrent agent tasks<Input name="tasks" type="number" required min="1" max="100" defaultValue={team.taskLimit} /><span className="text-xs leading-relaxed text-muted-foreground">Across this team's projects. The deployment also has a global limit of 5 tasks.</span></label><label className={field}>Concurrent platform requests<Input name="models" type="number" required min="1" max="100" defaultValue={team.modelLimit} /><span className="text-xs leading-relaxed text-muted-foreground">Model HTTP requests, counted separately from agent tasks.</span></label></div>
            <Button disabled={busy}>Save team limits</Button>
          </form> : <p className="mt-4 text-sm text-muted-foreground">Platform budget: {team.budgetUsd === null ? "Unlimited" : usd(team.budgetUsd)}. Agent task limit: {team.taskLimit}; platform request limit: {team.modelLimit}. Ask the platform admin to change these limits.</p>}
          <h3 className="mb-2 mt-8 text-sm font-medium">Usage by project</h3>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Platform usage for {team.name}</caption><thead className="border-b text-xs text-muted-foreground"><tr><th scope="col" className="py-3 pr-4 font-medium">Project</th><th scope="col" className="px-2 py-3 text-right font-medium">Spent USD</th><th scope="col" className="px-2 py-3 text-right font-medium">Reserved USD</th><th scope="col" className="py-3 pl-2 text-right font-medium">Unsettled</th></tr></thead><tbody className="divide-y">{teamUsage.length ? teamUsage.map(row => <tr key={row.projectId}><td className="py-3 pr-4">{row.name}</td><td className="px-2 py-3 text-right tabular-nums">{row.spentUsd.toFixed(4)}</td><td className="px-2 py-3 text-right tabular-nums">{row.reservedUsd.toFixed(4)}</td><td className="py-3 pl-2 text-right tabular-nums">{row.unsettled}</td></tr>) : <tr><td colSpan={4} className="py-6 text-muted-foreground">No platform model usage recorded yet.</td></tr>}</tbody></table></div>
          <p className="mt-3 text-xs text-muted-foreground">Recorded costs are estimates and may differ from provider invoices.</p>
          {user.role === "admin" && unsettled.length ? <section className="mt-8 border-t pt-5"><h3 className="text-sm font-medium">Reconcile unsettled calls</h3><p className="mb-4 mt-2 text-xs text-muted-foreground">Check the provider's usage before entering a confirmed cost.</p>{unsettled.map(call => <form key={call.id} className="mb-4 flex flex-wrap items-end gap-3" onSubmit={e => {
            e.preventDefault(); const form = new FormData(e.currentTarget);
            void action(() => managedRequest("/management/calls/" + call.id + "/reconcile", "POST", { costUsd: Number(form.get("cost")) }), "Confirmed cost recorded.");
          }}><div className="min-w-0 flex-1"><p className="break-words text-sm">{call.model}</p><p className="break-all text-xs text-muted-foreground">{call.id}</p></div><label className={field}>Confirmed cost (USD)<Input className="w-36" name="cost" type="number" min="0" step="0.000001" required /></label><Button disabled={busy}>Confirm cost</Button></form>)}</section> : null}
        </>}
      </div>
    </div>
  </main>;
}

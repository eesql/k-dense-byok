const IDENTITY_KEY = "kady:managed:identity";
let currentIdentity: string | undefined;
export function managedIdentityKey(): string | null {
  if (typeof window === "undefined" || process.env.NEXT_PUBLIC_KADY_MULTI_TENANT !== "1") return null;
  if (currentIdentity !== undefined) return currentIdentity || null;
  try { return window.localStorage.getItem(IDENTITY_KEY); } catch { return null; }
}
export function managedStorageKey(base: string): string {
  const identity = managedIdentityKey();
  return identity ? `kady:managed:${identity}:${base}` : base;
}
export function activateManagedIdentity(user: { id: string; tenantId: string | null }) {
  currentIdentity = `${user.id}:${user.tenantId ?? "admin"}`;
  try { window.localStorage.setItem(IDENTITY_KEY, currentIdentity); window.localStorage.removeItem("kady:apiToken"); } catch { /* In-memory partition still applies when persistence is unavailable. */ }
  document.cookie = "kady-project=; path=/; max-age=0; SameSite=Lax";
}
export function clearManagedIdentity() { currentIdentity = ""; try { window.localStorage.removeItem(IDENTITY_KEY); } catch { /* Best effort. */ } }

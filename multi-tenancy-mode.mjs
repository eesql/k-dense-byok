/** Deployment choice only: changing this requires a restart. No managed dependencies load when off. */
export function multiTenantEnabled(value = process.env.KADY_MULTI_TENANT) {
  if (value === undefined || value.trim() === "") return false;
  const normalized = value.trim().toLowerCase();
  if (["0", "false", "off"].includes(normalized)) return false;
  if (["1", "true", "on"].includes(normalized)) return true;
  throw new Error("KADY_MULTI_TENANT must be 1/on/true or 0/off/false");
}

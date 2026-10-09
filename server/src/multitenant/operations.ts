/** Shared managed admission boundary; names match the existing public API, not a heuristic over request bodies. */
export function isOneShotModelOperation(path: string): boolean {
  return path === "/sandbox/latex-assist" || path === "/speech/transcribe" || /\/notebook\/methods-draft$/.test(path) || /\/next-experiments\/generate$/.test(path);
}
export function startsManagedWork(path: string): boolean {
  return isOneShotModelOperation(path) || /\/(run|compact|resume|approve|submit|ensure-host)$/.test(path);
}

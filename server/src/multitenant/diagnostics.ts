import fs from "node:fs";

/** Diagnostic output is not a second credential store. Redact both environment and refreshed OAuth values. */
export function redactWorkerDiagnostic(line: string, envFile: string, authFile: string, privateTokens: string[]): string {
  const secrets = new Set(privateTokens);
  try {
    for (const raw of fs.readFileSync(envFile, "utf8").split("\n")) {
      const entry = /^\s*(?:export\s+)?(\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*)\s*=\s*(.*)$/.exec(raw);
      if (!entry) continue;
      const quoted = /^"([^"]*)"|^'([^']*)'/.exec(entry[2]);
      const value = quoted ? quoted[1] ?? quoted[2] : entry[2].replace(/\s+#.*$/, "").trim();
      if (value.length >= 8) secrets.add(value);
    }
    const collect = (value: unknown) => {
      if (typeof value === "string" && value.length >= 8) secrets.add(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    if (fs.existsSync(authFile)) collect(JSON.parse(fs.readFileSync(authFile, "utf8")));
  } catch { return "[worker diagnostic withheld: credential redaction unavailable]\n"; }
  for (const secret of secrets) if (secret) line = line.replaceAll(secret, "[redacted]");
  return line;
}

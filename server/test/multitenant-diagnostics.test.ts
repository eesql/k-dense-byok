import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { redactWorkerDiagnostic } from "../src/multitenant/diagnostics.ts";

it("removes environment, private callback and refreshed OAuth credentials from diagnostics", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kady-log-redaction-"));
  const env = path.join(root, "worker.env"), auth = path.join(root, "auth.json");
  try {
    fs.writeFileSync(env, 'OPENROUTER_API_KEY="synthetic-key-value"\n');
    fs.writeFileSync(auth, JSON.stringify({ openai: { access: "synthetic-access-value", refresh: "synthetic-refresh-value" } }));
    const output = redactWorkerDiagnostic("Error: synthetic-key-value synthetic-access-value synthetic-refresh-value private-callback-value", env, auth, ["private-callback-value"]);
    expect(output).toBe("Error: [redacted] [redacted] [redacted] [redacted]");
    fs.writeFileSync(auth, "malformed secret config");
    expect(redactWorkerDiagnostic("sensitive error", env, auth, [])).not.toContain("sensitive error");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

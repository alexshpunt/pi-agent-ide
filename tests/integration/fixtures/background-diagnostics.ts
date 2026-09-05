import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL } from "pi-agent-ide/api/plugin-protocol";
import type { IdeDiagnosticContext, IdeDiagnosticReport, IdePluginApi } from "pi-agent-ide/api/plugin-protocol";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Controlled analysis providers: only the control tool can finish a check. */
export default async function backgroundFixture(pi: ExtensionAPI): Promise<void> {
  let api: IdePluginApi;
  const jobs = new Map<string, { context: IdeDiagnosticContext; finish: (report: IdeDiagnosticReport) => void }>();
  const started = new Map<string, () => void>();
  const waitFor = (key: string) => jobs.has(key) ? Promise.resolve() : new Promise<void>((resolve) => started.set(key, resolve));
  const clean: IdeDiagnosticReport = { status: "ready", diagnostics: [] };
  const report = (severity: "error" | "warning"): IdeDiagnosticReport => ({ status: "ready", diagnostics: [
    { line: 1, column: 1, code: "fixture", severity, message: `${severity} detail only on explicit read` },
  ] });
  await connectIdePlugin(pi, {
    protocol: IDE_PROTOCOL, apiVersion: IDE_API_VERSION, id: "controlled-diagnostics",
    setup(value) {
      api = value;
      value.addTool({ kind: "formatter", name: "fixture-format", priority: 1000, extensions: [".ts"],
        detect: async () => true,
        async format({ filePath }) {
          const before = await readFile(filePath, "utf8");
          if (before.includes("SYNTAX_INVALID")) return { ok: false, edits: 0 };
          await writeFile(filePath, `${before.trim()}\n`);
          return { ok: true, edits: 1 };
        },
      });
      for (const id of ["lsp", "lint"]) value.addDiagnosticSource({ id,
        diagnose: (_filePath, context) => new Promise((finish) => {
          const key = `${context.content.trim()}:${id}`;
          jobs.set(key, { context, finish }); started.get(key)?.();
        }),
      });
    },
  });
  pi.registerTool({
    name: "diagnostic_control", label: "Diagnostic control", description: "Release controlled diagnostics.",
    parameters: Type.Object({ action: Type.String() }),
    async execute(_id, { action }, _signal, _update, ctx) {
      const file = path.join(ctx.cwd, "example.ts");
      if (action === "started") {
        await Promise.all([waitFor("A:lsp"), waitFor("A:lint")]);
        return { content: [{ type: "text", text: "Both checks started after formatting." }], details: {} };
      }
      if (action === "partial") {
        await Promise.all([waitFor("B:lsp"), waitFor("B:lint")]);
        if (!jobs.get("A:lsp")?.context.signal.aborted) throw new Error("Old check was not cancelled");
        jobs.get("A:lsp")?.finish(report("error")); jobs.get("A:lint")?.finish(report("error"));
        jobs.get("B:lint")?.finish(report("warning"));
      } else if (action === "complete") {
        jobs.get("B:lsp")?.finish(report("error"));
      } else if (action === "clear") {
        await Promise.all([waitFor("C:lsp"), waitFor("C:lint")]);
        jobs.get("C:lsp")?.finish(clean); jobs.get("C:lint")?.finish(clean);
      } else if (action === "repeat") {
        jobs.get("B:lsp")?.context.publish(report("error"));
      }
      const snapshot = await api.readDiagnostics(file, { cwd: ctx.cwd });
      return { content: [{ type: "text", text: snapshot.results.map((item) => `${item.source}:${item.status}`).join(",") }], details: {} };
    },
  });
  pi.on("agent_end", () => { jobs.get("C:lsp")?.context.publish(report("error")); });
}

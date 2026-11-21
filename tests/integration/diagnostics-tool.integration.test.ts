import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";

// A real diagnostic provider with deterministic findings; no inference or external server.
const extensions = [
  "builtin:codemode",
  path.resolve("src/pi-agent-ide.ts"),
  path.resolve("tests/integration/fixtures/diagnostics-tool.ts"),
];

test("diagnostics reports stay readable and searchable without granting file edit authority", async () => {
  const root = path.resolve(".tmp/diagnostics-tool");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "project-"));
  const source = "export const value = 1;\n";
  try {
    await writeFile(path.join(cwd, "example.note"), source);
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lint", "ide.lsp"] }),
    );
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    const result = await new PiIntegrationTest({
      testName: "diagnostics-tool-composition",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions,
      tools: ["diagnostics", "read", "search", "replace", "codemode"],
      rawMode: false,
      conversation: [
        call("direct", "diagnostics", { path: "example.note" }),
        call("composition", "codemode", {
          code: `
const report = await tools.diagnostics({path: "example.note"});
if (!report || typeof report.id !== "string" || !report.text.includes("FIXTURE42")) throw new Error("Missing report value");
const reread = await tools.read({path: report});
if (!reread?.text.includes("FIXTURE42")) throw new Error("Report reread lost the finding");
const derived = await tools.search({path: reread, query: "FIXTURE42"});
if (derived?.matches.length !== 1) throw new Error("Reread lost searchable selection");
const found = await tools.search({path: report, query: "FIXTURE42"});
if (found?.matches.length !== 1) throw new Error("Report search lost the finding");
const edit = await tools.replace({path: report, at: "value", text: "changed"});
if (edit !== null) throw new Error("Report became an edit scope");
const derivedEdit = await tools.replace({path: found, text: "changed"});
if (derivedEdit !== null) throw new Error("Search granted report edit authority");
text("composition-verified");`,
        }),
        call("overlay", "read", { path: "example.note", views: ["diagnostics"] }),
        call("removed", "read", { path: "diagnostics:example.note" }),
        assistantMessage([text("Done")]),
      ],
    }).run("Inspect diagnostics, reuse the report, and check that it cannot edit the source.");
    for (const id of ["direct", "composition", "overlay"])
      expect(getToolExecution(result, id).isError).not.toBe(true);
    expect(getToolResultText(result, "direct")).toContain("fixture:FIXTURE42");
    expect(getToolResultText(result, "composition")).toContain("composition-verified");
    expect(getToolResultText(result, "overlay")).toContain("fixture:FIXTURE42");
    expect(getToolExecution(result, "removed").isError).toBe(true);
    expect(await readFile(path.join(cwd, "example.note"), "utf8")).toBe(source);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);

test.each(["pending", "unavailable", "snapshot", "ready"] as const)(
  "%s readiness is preserved even for an empty diagnostic report",
  async (status) => {
    const root = path.resolve(".tmp/diagnostics-tool");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "readiness-"));
    try {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lint", "ide.lsp"] }),
      );
      await writeFile(path.join(cwd, status + ".note"), "unchanged\n");
      const result = await new PiIntegrationTest({
        testName: "diagnostics-readiness-" + status,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        extensions,
        tools: ["diagnostics", "codemode"],
        conversation: [
          assistantMessage(
            [toolCall({ id: "check", name: "diagnostics", arguments: { path: status + ".note" } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "script",
                name: "codemode",
                arguments: {
                  code: `const report = await tools.diagnostics({path: ${JSON.stringify(status + ".note")}});
if (!report || typeof report.id !== "string" || typeof report.text !== "string") throw new Error("Missing report value");
if (${JSON.stringify(status)} !== "ready" && !report.text.includes(${JSON.stringify(status)})) throw new Error("Missing readiness status");
text("report-verified");`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Check diagnostic readiness.");
      expect(getToolExecution(result, "check").isError).not.toBe(true);
      if (status !== "ready") expect(getToolResultText(result, "check")).toContain(status);
      for (const id of ["check", "script/1"]) {
        expect(getToolExecution(result, id).isError).not.toBe(true);
        expect(getToolExecutionDetails(getToolExecution(result, id))).toMatchObject({
          diagnosticCheck: { complete: status === "ready", count: 0, sources: ["fixture"] },
        });
      }
      expect(getToolExecution(result, "script").isError).not.toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  60_000,
);

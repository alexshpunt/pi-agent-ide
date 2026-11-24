import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { selectedDirections, startTargetFixture } from "#integration/support/ssh-target-fixture.ts";
import { remoteLocation } from "#src/backend/identity.ts";
import { formatCodeViewReference } from "#src/code-view/reference.ts";

afterAll(forceStandaloneIntegrationFile());

// Point this at a target directory with TypeScript and typescript-language-server installed
// under node_modules. ast-grep must also be on the Windows SSH account's PATH.
const helpersRoot = process.env.PI_SSH_WINDOWS_HELPERS_ROOT;

test.skipIf(
  !helpersRoot || !selectedDirections().some((direction) => direction.endsWith(">windows")),
)(
  "Windows SSH owns TypeScript diagnostics and symbol locations, AST search and outline",
  async () => {
    if (!helpersRoot) throw new Error("PI_SSH_WINDOWS_HELPERS_ROOT is required");
    const fixture = await startTargetFixture("windows");
    const base = path.resolve(".tmp/ssh-windows-code-intelligence");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    const project = "Project with spaces";
    const file = "greeting #1.ts";
    const root = remoteLocation("fixture", fixture.canonical(project), "windows").source;
    const note = remoteLocation(
      "fixture",
      fixture.canonical(`${project}/${file}`),
      "windows",
    ).source;
    const missingProject = "Missing server project";
    const unavailable = remoteLocation(
      "fixture",
      fixture.canonical(`${missingProject}/missing.lpt1286`),
      "windows",
    ).source;
    const declaration = formatCodeViewReference("graph", note, ["helloOwner"]).slice(
      "graph:".length,
    );
    const code = [
      "export function helloOwner(): number {",
      '  const value = "café";',
      "  console.log(value);",
      "  return value;",
      "}",
      "",
    ].join("\n");
    const command = "pi-ide-fixture-missing-lpt1286";
    try {
      await fixture.put(
        `${project}/tsconfig.json`,
        JSON.stringify({ compilerOptions: { strict: true } }),
      );
      await fixture.put(`${project}/${file}`, code);
      await fixture.put(`${missingProject}/missing.lpt1286`, "export const missingOwner = true;\n");

      // Install just a wrapper in the fixture, so built-in discovery and launch both
      // need its native node_modules/.bin entry and .CMD from PATHEXT.
      const bin = fixture.canonical(`${project}/node_modules/.bin`).slice(1);
      const cli = path.win32.join(
        helpersRoot,
        "node_modules",
        "typescript-language-server",
        "lib",
        "cli.mjs",
      );
      const relative = path.win32.relative(bin, cli);
      if (path.win32.isAbsolute(relative))
        throw new Error("Fixture and helpers must be on the same drive");
      await fixture.put(
        `${project}/node_modules/.bin/typescript-language-server.cmd`,
        `@echo off\r\nset dp0=%~dp0\r\nset _prog=node\r\n"%_prog%" "%dp0%\\${relative}" %*\r\n`,
      );
      await fixture.put(
        `${missingProject}/.pi/pi-agent-ide/lsp-servers.json`,
        JSON.stringify({
          version: 1,
          servers: {
            missing: {
              command: [command],
              rootMarkers: [],
              languages: { typescript: { extensions: [".lpt1286"] } },
              capabilities: ["diagnostics"],
            },
          },
        }),
      );
      const config = path.join(cwd, ".pi/pi-agent-ide");
      await mkdir(config, { recursive: true });
      await writeFile(path.join(config, "ssh.json"), JSON.stringify({ targets: [fixture.target] }));
      await writeFile(
        path.join(config, "extensions.json"),
        JSON.stringify({
          noAnimations: true,
          noPostProcessing: true,
          disabled: ["ide.formatter", "ide.lint", "ide.debugger", "ide.terminal"],
        }),
      );
      const run = await new PiIntegrationTest({
        testName: "ssh-windows-code-intelligence",
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts")],
        tools: ["lsp_search", "diagnostics", "read", "ast_search", "outline"],
        timeoutMs: 240_000,
        conversation: [
          assistantMessage([
            toolCall({
              id: "symbols",
              name: "lsp_search",
              arguments: { path: root, query: "helloOwner" },
            }),
          ]),
          assistantMessage([
            toolCall({
              id: "declaration",
              name: "lsp_search",
              arguments: { declaration },
            }),
          ]),
          ...["start-diagnostics", "wait-diagnostics", "diagnostics"].map((id) =>
            assistantMessage([toolCall({ id, name: "diagnostics", arguments: { path: note } })]),
          ),
          assistantMessage([
            toolCall({
              id: "diagnostic-view",
              name: "read",
              arguments: { path: note, views: ["diagnostics"] },
            }),
          ]),
          assistantMessage([
            toolCall({
              id: "structural",
              name: "ast_search",
              arguments: { path: note, pattern: "console.log($VALUE)" },
            }),
          ]),
          assistantMessage([
            toolCall({ id: "ast", name: "read", arguments: { path: note, views: ["ast"] } }),
          ]),
          assistantMessage([
            toolCall({ id: "outline", name: "outline", arguments: { path: note } }),
          ]),
          ...["start-missing", "wait-missing", "missing"].map((id) =>
            assistantMessage([
              toolCall({ id, name: "diagnostics", arguments: { path: unavailable } }),
            ]),
          ),
          assistantMessage([text("Checked the Windows project.")]),
        ],
      }).run("Inspect the Windows project's types, diagnostics and structure.");
      for (const id of [
        "symbols",
        "declaration",
        "diagnostics",
        "diagnostic-view",
        "structural",
        "ast",
        "outline",
      ])
        expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      expect(getToolResultText(run, "symbols")).toContain(note);
      expect(getToolResultText(run, "declaration")).toContain(
        "export function helloOwner(): number",
      );
      expect(getToolResultText(run, "diagnostics")).toContain("2322");
      expect(getToolResultText(run, "diagnostic-view")).toContain("2322");
      expect(getToolResultText(run, "structural")).toContain("console.log(value)");
      expect(getToolResultText(run, "ast")).toContain("scope-begin-");
      expect(getToolResultText(run, "outline")).toContain("helloOwner");
      expect(getToolResultText(run, "missing")).toContain(command);
      expect(run.tuiRenderedOutput).toContain("helloOwner");
      expect((await fixture.get(`${project}/${file}`)).toString("utf8")).toBe(code);
    } finally {
      await fixture.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  300_000,
);

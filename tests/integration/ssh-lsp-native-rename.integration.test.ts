import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackend } from "#src/backend/ssh.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test.each(["cold graph", "rename"] as const)(
  "installed target TypeScript server keeps complete references for %s",
  async (mode) => {
    const fixture = await startSshFixture({}, { PI_CODING_AGENT_DIR: "{workspace}/agent-home" });
    const base = path.resolve(".tmp/ssh-lsp-native-rename");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    const backend = new SshBackend({
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    });
    const root = `ssh://fixture${fixture.workspace}`;
    const note = 'export function greet(value: string): string { return value + " café"; }\r\n';
    const reference =
      'import { greet } from "./note";\r\nexport function caller(): string { return greet("owned"); }\r\n';
    try {
      const version = await backend.execute(
        "/usr/bin/typescript-language-server",
        ["--version"],
        fixture.workspace,
      );
      expect(version.exitCode).toBe(0);
      expect(version.stdout.toString("utf8").trim()).toMatch(/^\d+\.\d+\.\d+$/u);
      for (const [name, content] of Object.entries({
        "note.ts": note,
        "reference.ts": reference,
        "tsconfig.json": JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "ESNext" },
          include: ["*.ts"],
        }),
        "start-server.sh":
          'printf "%s\\n" "$$" > "$1/server.pid"\nexec /usr/bin/typescript-language-server --stdio\n',
        ".pi/pi-agent-ide/lsp-servers.json": JSON.stringify({
          version: 1,
          servers: {
            owned: {
              command: ["/bin/sh", "{project}/start-server.sh", "{project}"],
              rootMarkers: ["tsconfig.json"],
              requireRootMarker: true,
              languages: { typescript: { extensions: [".ts"] } },
              capabilities: ["diagnostics"],
            },
          },
        }),
      }))
        await backend.write(`${fixture.workspace}/${name}`, Buffer.from(content), null);
      await writeFile(path.join(cwd, "note.ts"), note);
      await writeFile(path.join(cwd, "reference.ts"), reference);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
        JSON.stringify({ targets: [backend.target] }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({
          noAnimations: true,
          noPostProcessing: true,
          disabled: [
            "ide.ast",
            "ide.formatter",
            "ide.lint",
            "ide.debugger",
            "ide.vision",
            "ide.diagnostics",
          ],
        }),
      );
      const inspect = [
        "import json,pathlib,sys",
        "root=int(pathlib.Path(sys.argv[1]).read_text()); pending=[root]; pids=[]",
        "while pending:",
        " p=pending.pop(); d=pathlib.Path('/proc')/str(p)",
        " if not d.exists(): continue",
        " pids.append(p); pending.extend(map(int,(d/'task'/str(p)/'children').read_text().split()))",
        "print('OWNED_LSP_PIDS='+json.dumps(sorted(pids)))",
      ].join("\n");
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const command = `python3 -c ${quote(inspect)} ${quote(`${fixture.workspace}/server.pid`)}`;
      const run = await new PiIntegrationTest({
        testName: `ssh-lsp-native-${mode.replaceAll(" ", "-")}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "replace", "search", "bash", "delete", "codemode"],
        timeoutMs: 90000,
        conversation: [
          assistantMessage([
            toolCall({
              id: "graph",
              name: "read",
              arguments: { path: `graph:${root}/note.ts#greet` },
            }),
          ]),
          ...(mode === "rename"
            ? [
                assistantMessage([
                  toolCall({
                    id: "rename",
                    name: "replace",
                    arguments: { path: `symbol:${root}/note.ts#greet#name`, text: "welcome" },
                  }),
                ]),
                assistantMessage([
                  toolCall({
                    id: "renamed-note",
                    name: "read",
                    arguments: { path: `${root}/note.ts` },
                  }),
                ]),
                assistantMessage([
                  toolCall({
                    id: "renamed-reference",
                    name: "read",
                    arguments: { path: `${root}/reference.ts` },
                  }),
                ]),
                assistantMessage([
                  toolCall({
                    id: "renamed-graph",
                    name: "read",
                    arguments: { path: `graph:${root}/note.ts#welcome` },
                  }),
                ]),
              ]
            : []),
          assistantMessage([
            toolCall({
              id: "native",
              name: "codemode",
              arguments: {
                code: `
const definition = await tools.search({ query: ${JSON.stringify(`symbols:${mode === "rename" ? "welcome" : "greet"}`)}, path: ${JSON.stringify(`${root}/note.ts`)} });
if(!definition.includes("definition ") || definition.includes("reference ")) throw Error(definition);
const references = await tools.search({ query: ${JSON.stringify(`symbols:${mode === "rename" ? "welcome" : "greet"}`)}, path: definition, navigation: "references" });
const declarations=[...references.matchAll(/declared at (.+)/g)].map(m=>m[1]); if(declarations.length!==3 || new Set(declarations).size!==1) throw Error(references);
const inspected = await tools.bash({ command: ${JSON.stringify(command)}, cwd: ${JSON.stringify(root)} });
text({ definition, references, inspected });
const shell=/session: (shell:[a-zA-Z0-9-]+)/.exec(inspected)?.[1]; if(!shell) throw Error("No owned shell source"); await tools.delete({path:shell});
`,
              },
            }),
          ]),
          assistantMessage([text("Installed server rename and native calls verified.")]),
        ],
      }).run(
        "Rename only the configured SSH declaration through its native language server and preserve controller files.",
      );
      for (const id of [
        "graph",
        "native",
        ...(mode === "rename"
          ? ["rename", "renamed-note", "renamed-reference", "renamed-graph"]
          : []),
      ])
        expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      for (const id of mode === "rename" ? ["graph", "renamed-graph"] : ["graph"]) {
        expect(getToolResultText(run, id)).toContain(`${root}/reference.ts`);
        expect(getToolResultText(run, id)).toContain("Incoming calls: 1");
        expect(getToolResultText(run, id)).toContain("References: 3 in 2 file(s)");
        expect(getToolResultText(run, id)).toContain("caller");
      }
      expect((await backend.read(`${fixture.workspace}/note.ts`)).bytes.toString("utf8")).toBe(
        mode === "rename" ? note.replaceAll("greet", "welcome") : note,
      );
      expect((await backend.read(`${fixture.workspace}/reference.ts`)).bytes.toString("utf8")).toBe(
        mode === "rename" ? reference.replaceAll("greet", "welcome") : reference,
      );
      expect(await readFile(path.join(cwd, "note.ts"), "utf8")).toBe(note);
      expect(await readFile(path.join(cwd, "reference.ts"), "utf8")).toBe(reference);
      const marker = /OWNED_LSP_PIDS=(\[[\d, ]+\])/u.exec(getToolResultText(run, "native"));
      if (!marker?.[1]) throw Error("No exact native language-server tree was recorded");
      const pids: unknown = JSON.parse(marker[1]);
      if (
        !Array.isArray(pids) ||
        pids.length < 3 ||
        !pids.every((pid) => Number.isSafeInteger(pid) && Number(pid) > 0)
      )
        throw Error("Expected the installed server and its native workers");
      const gone = await backend.execute(
        "python3",
        [
          "-c",
          "import os,sys; assert all(not os.path.exists('/proc/'+p) for p in sys.argv[1:]); print('OWNED_LSP_GONE')",
          ...pids.map(String),
        ],
        fixture.workspace,
      );
      expect(gone.exitCode, gone.stderr.toString("utf8")).toBe(0);
      expect(gone.stdout.toString("utf8")).toContain("OWNED_LSP_GONE");
      expect(run.tuiRenderedOutput).toContain(`${root}/note.ts`);
      expect(run.tuiRenderedOutput).toContain(mode === "rename" ? "welcome" : "greet");
    } finally {
      await fixture.stop();
      await rm(cwd, { recursive: true, force: true });
    }
    await expect(readFile(path.join(fixture.root, "sshd.pid"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(`/proc/${fixture.serverPid}/stat`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
  120000,
);

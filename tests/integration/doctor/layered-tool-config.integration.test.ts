import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";

const root = path.resolve(".agents", "tmp", "layered-tool-config-integration");
const extension = path.resolve("src", "pi-agent-ide.ts");
const workspaces: string[] = [];
const restoreSharedRunner = forceStandaloneIntegrationFile();

beforeAll(async () => {
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  restoreSharedRunner();
});

test("the real doctor probes the effective project and global entries with provenance", async () => {
  const { project, agentDirectory } = await layeredWorkspace({});
  const result = await new PiIntegrationTest({
    testName: "doctor-layered-effective-config",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: project,
    extensions: [extension],
    tools: [],
    isolateUserResources: false,
    environment: {
      PI_CODING_AGENT_DIR: agentDirectory,
      PATH: `${path.join(project, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    conversation: [assistantMessage([text("Layered setup reviewed")])],
  }).run("/pi-agent-ide-doctor --no-apply --agent");

  expect(result.exitCode).toBe(0);
  const transcript = JSON.stringify(result.messages);
  expect(transcript).toContain("shared-formatter [project]");
  expect(transcript).toContain("project-format-tool");
  expect(transcript).toContain("global-linter [global]");
  expect(transcript).toContain("global-lint-tool");
  expect(transcript).toContain("global-lsp [global]");
  expect(transcript).toContain("global-lsp-tool");
  expect(transcript).not.toContain("global-format-tool");
  expect(transcript).not.toContain("config is not created");
});

test("an invalid formatter layer does not hide valid linter and LSP checks", async () => {
  const { project, agentDirectory } = await layeredWorkspace({ invalidFormatter: true });
  const result = await new PiIntegrationTest({
    testName: "doctor-layered-category-error",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: project,
    extensions: [extension],
    tools: [],
    isolateUserResources: false,
    environment: {
      PI_CODING_AGENT_DIR: agentDirectory,
      PATH: `${path.join(project, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    conversation: [assistantMessage([text("Category failure reviewed")])],
  }).run("/pi-agent-ide-doctor --no-apply --agent");

  const transcript = JSON.stringify(result.messages);
  expect(transcript).toMatch(/Formatter[\s\S]*FAIL[\s\S]*shared-formatter/);
  expect(transcript).toContain("global-linter [global]");
  expect(transcript).toContain("global-lsp [global]");
});

test("malformed linter output is reported without breaking the rest of doctor", async () => {
  const { project, agentDirectory } = await layeredWorkspace({ malformedLinterOutput: true });
  const result = await new PiIntegrationTest({
    testName: "doctor-malformed-linter-output",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd: project,
    extensions: [extension],
    tools: [],
    isolateUserResources: false,
    environment: {
      PI_CODING_AGENT_DIR: agentDirectory,
      PATH: `${path.join(project, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    conversation: [assistantMessage([text("Malformed linter output reviewed")])],
  }).run("/pi-agent-ide-doctor --no-apply --agent");

  expect(result.exitCode).toBe(0);
  const transcript = JSON.stringify(result.messages);
  expect(transcript).toMatch(/Linter[\s\S]*FAIL[\s\S]*invalid sarif diagnostics/);
  expect(transcript).toContain("global-lsp [global]");
});

async function layeredWorkspace(options: {
  readonly invalidFormatter?: boolean;
  readonly malformedLinterOutput?: boolean;
}): Promise<{
  readonly project: string;
  readonly agentDirectory: string;
}> {
  const project = await mkdtemp(path.join(root, "project-"));
  const agentDirectory = await mkdtemp(path.join(root, "agent-"));
  workspaces.push(project, agentDirectory);
  await mkdir(path.join(project, "bin"), { recursive: true });
  await writeFile(path.join(project, "source.ts"), "export const value = 1;\n", "utf8");

  for (const [name, content] of [
    ["project-format-tool", "#!/usr/bin/env node\n"],
    ["global-format-tool", "#!/usr/bin/env node\n"],
    [
      "global-lint-tool",
      options.malformedLinterOutput
        ? "#!/usr/bin/env node\nprocess.stdout.write('This oxlint output is not SARIF');\n"
        : "#!/usr/bin/env node\n",
    ],
    ["global-lsp-tool", lspTool()],
  ] as const) {
    const file = path.join(project, "bin", name);
    await writeFile(file, content, "utf8");
    await chmod(file, 0o755);
  }

  await writeConfig(path.join(agentDirectory, "extensions", "pi-agent-ide", "formatters.json"), {
    version: 1,
    formatters: {
      "shared-formatter": formatter("global-format-tool"),
    },
  });
  await writeConfig(path.join(agentDirectory, "extensions", "pi-agent-ide", "linters.json"), {
    version: 1,
    linters: {
      "global-linter": {
        extensions: [".ts"],
        check: { command: ["global-lint-tool", "{file}"] },
        diagnostics: { format: options.malformedLinterOutput ? "sarif" : "gcc" },
      },
    },
  });
  await writeConfig(path.join(agentDirectory, "extensions", "pi-agent-ide", "lsp-servers.json"), {
    version: 1,
    servers: {
      "global-lsp": {
        command: ["global-lsp-tool"],
        rootMarkers: [],
        languages: { typescript: { extensions: [".ts"] } },
        capabilities: ["diagnostics"],
      },
    },
  });
  await writeConfig(path.join(project, ".pi", "pi-agent-ide", "formatters.json"), {
    version: 1,
    formatters: {
      "shared-formatter": options.invalidFormatter
        ? { extensions: [".ts"] }
        : formatter("project-format-tool"),
    },
  });
  return { project, agentDirectory };
}

function formatter(executable: string): Record<string, unknown> {
  return {
    extensions: [".ts"],
    run: { command: [executable, "{file}"] },
    output: "in-place",
  };
}

async function writeConfig(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value), "utf8");
}

function lspTool(): string {
  return `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => { buffer = Buffer.concat([buffer, chunk]); drain(); });
function drain() { while (true) { const split = buffer.indexOf("\\r\\n\\r\\n"); if (split < 0) return; const header = buffer.subarray(0, split).toString(); const match = /Content-Length: (\\d+)/i.exec(header); if (!match) return; const length = Number(match[1]); if (buffer.length < split + 4 + length) return; const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length)); buffer = buffer.subarray(split + 4 + length); if (message.id !== undefined) respond(message.id, message.method === "initialize" ? { capabilities: {} } : null); if (message.method === "exit") process.exit(0); } }
function respond(id, result) { const body = JSON.stringify({ jsonrpc: "2.0", id, result }); process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body); }
`;
}

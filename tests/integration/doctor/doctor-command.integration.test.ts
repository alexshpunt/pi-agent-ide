import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, expect, test } from "vitest";

import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";

const root = path.resolve(".agents", "tmp", "doctor-command-integration");
const extension = path.resolve("src", "pi-agent-ide.ts");
const workspaces: string[] = [];

beforeAll(async () => {
  await mkdir(root, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

test("the real Pi command detects C++ and applies plugin-owned recipes", async () => {
  const cwd = await cppWorkspace();
  const result = await new PiIntegrationTest({
    testName: "doctor-cpp-apply",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [extension],
    tools: [],
    environment: { PATH: `${path.join(cwd, "bin")}${path.delimiter}${process.env.PATH ?? ""}` },
    conversation: [assistantMessage([text("Setup reviewed")])],
  }).run("/pi-agent-ide-doctor --apply --agent");

  expect(result.exitCode).toBe(0);
  const transcript = JSON.stringify(result.messages);
  expect(transcript).toContain("Detected: cpp");
  expect(transcript).toContain("clang-format [formatter]");
  expect(transcript).toContain("clangd [lsp]");
  expect(transcript).toContain("ripgrep is available");
  expect(transcript).toContain("ast-grep is available");
  expect(transcript).toContain("Git is available");
  expect(transcript).not.toContain("irrelevant-formatter");
  expect(transcript).not.toContain("irrelevant-linter");
  expect(transcript).not.toContain("irrelevant-language-server");
  expect(JSON.stringify(result.traceEvents)).toContain("Doctor recheck after agent setup");
  expect(
    JSON.parse(await readFile(path.join(cwd, ".pi", "pi-agent-ide", "formatters.json"), "utf8")),
  ).toMatchObject({
    version: 1,
    formatters: { "clang-format": {} },
  });
  expect(
    JSON.parse(await readFile(path.join(cwd, ".pi", "pi-agent-ide", "linters.json"), "utf8")),
  ).toMatchObject({
    version: 1,
    linters: { "clang-tidy": {} },
  });
  expect(
    JSON.parse(await readFile(path.join(cwd, ".pi", "pi-agent-ide", "lsp-servers.json"), "utf8")),
  ).toMatchObject({ version: 1, servers: { clangd: {} } });
});

test("disabling plugins removes their doctor checks and catalog knowledge", async () => {
  const cwd = await cppWorkspace();
  const config = path.join(cwd, "pi-agent-ide.json");
  await writeFile(
    config,
    JSON.stringify({
      disabledExtensions: ["ide.formatter", "search.text", "ide.ast", "ide.changes"],
    }),
    "utf8",
  );
  const result = await new PiIntegrationTest({
    testName: "doctor-disabled-runtime-plugins",
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [extension],
    tools: [],
    environment: {
      PATH: `${path.join(cwd, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
      PI_AGENT_IDE_CONFIG: config,
    },
    conversation: [assistantMessage([text("Setup reviewed")])],
  }).run("/pi-agent-ide-doctor --no-apply --agent");

  const transcript = JSON.stringify(result.messages);
  expect(transcript).not.toContain("Formatter (formatter)");
  expect(transcript).not.toContain("clang-format [formatter]");
  expect(transcript).not.toContain("Local search (search-text)");
  expect(transcript).not.toContain("Structural search (ast)");
  expect(transcript).not.toContain("Git changes (changes)");
  expect(transcript).toContain("clang-tidy [lint]");
});

async function cppWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(root, "cpp-"));
  workspaces.push(cwd);
  await mkdir(path.join(cwd, "bin"));
  await writeFile(path.join(cwd, "main.cpp"), "int main() { return 0; }\n", "utf8");
  await writeFile(path.join(cwd, ".clang-format"), "BasedOnStyle: LLVM\n", "utf8");
  await writeFile(path.join(cwd, ".clang-tidy"), "Checks: modernize-*\n", "utf8");
  await writeFile(path.join(cwd, ".clangd"), "CompileFlags: {}\n", "utf8");
  await mkdir(path.join(cwd, ".pi", "pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi", "pi-agent-ide", "formatters.json"),
    JSON.stringify({
      version: 1,
      formatters: {
        "irrelevant-formatter": {
          extensions: [".rb"],
          run: { command: ["irrelevant-formatter", "{file}"] },
          output: "in-place",
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(cwd, ".pi", "pi-agent-ide", "linters.json"),
    JSON.stringify({
      version: 1,
      linters: {
        "irrelevant-linter": {
          extensions: [".rb"],
          check: { command: ["irrelevant-linter", "{file}"] },
          diagnostics: { format: "regex", pattern: "fixture" },
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(cwd, ".pi", "pi-agent-ide", "lsp-servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        "irrelevant-language-server": {
          command: ["irrelevant-language-server"],
          rootMarkers: [],
          languages: { ruby: { extensions: [".rb"] } },
          capabilities: ["diagnostics"],
        },
      },
    }),
    "utf8",
  );
  for (const name of ["clang-format", "clang-tidy", "clangd", "ast-grep", "rg"]) {
    const file = path.join(cwd, "bin", name);
    await writeFile(file, cppTool(name === "clangd"), "utf8");
    await chmod(file, 0o755);
  }
  return cwd;
}

function cppTool(lsp: boolean): string {
  if (!lsp) {
    return "#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs'; const file = process.argv.at(-1); if (process.argv[1].endsWith('clang-format')) appendFileSync(file, '\\n'); else process.stdout.write(file + ':1:1: warning: fixture [fixture]\\n');\n";
  }
  return `#!/usr/bin/env node
let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => { buffer = Buffer.concat([buffer, chunk]); drain(); });
function drain() { while (true) { const split = buffer.indexOf("\\r\\n\\r\\n"); if (split < 0) return; const header = buffer.subarray(0, split).toString(); const match = /Content-Length: (\\d+)/i.exec(header); if (!match) return; const length = Number(match[1]); if (buffer.length < split + 4 + length) return; const message = JSON.parse(buffer.subarray(split + 4, split + 4 + length)); buffer = buffer.subarray(split + 4 + length); if (message.id !== undefined) respond(message.id, message.method === "initialize" ? { capabilities: {} } : null); if (message.method === "exit") process.exit(0); } }
function respond(id, result) { const body = JSON.stringify({ jsonrpc: "2.0", id, result }); process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body); }
`;
}

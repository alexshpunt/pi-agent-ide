import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";

import { generateReadExtensions } from "pi-agent-read/testing";

const generatedExtensions = await generateReadExtensions([
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.ts",
  "src/plugins/pi-agent-ide-lsp/index.ts",
]);
const tempRoot = path.resolve(".tmp/pi-agent-lsp");

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("read shows LSP diagnostics without changing the source", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "lsp-diagnostics.ts";
    const file = path.join(directory, fileName);
    const source = [
      "export function getValue(): number {",
      '    const value: number = "wrong";',
      "    return value;",
      "}",
      "",
    ].join("\n");
    await writeTypeScriptProject(directory, fileName, source);

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-lsp-diagnostics",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-lsp-diagnostics",
              name: "read",
              arguments: { path: fileName, offset: 2, limit: 1 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The LSP diagnostic read finished")]),
      ],
    }).run("Read the invalid TypeScript line and inspect its LSP diagnostics");

    expect(await readFile(file, "utf8")).toBe(source);

    const rendered = getToolResultText(result, "read-lsp-diagnostics");
    expect(rendered).toContain('const value: number = "wrong"');
    expect(rendered).toContain("<!-- lsp:");
    expect(rendered).toContain("[ERROR] lsp:2322:");
    expect(rendered).not.toContain("export function getValue");

    const message = getToolResultMessage(result, "read-lsp-diagnostics");
    const details = message.details as {
      readonly startLine?: number;
      readonly endLine?: number;
      readonly totalLines?: number;
      readonly lines?: readonly { readonly lineNumber: number }[];
    };

    expect(details).toMatchObject({ startLine: 2, endLine: 2, totalLines: 4 });
    expect(details.lines?.map((line) => line.lineNumber)).toEqual([2]);
    expect(details.lines?.[0]).not.toHaveProperty("hints");
  });
}, 60_000);

test("lsp protocol returns only lines with error diagnostics", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "lsp-protocol.ts";
    const source = [
      "export function getValue(): number {",
      '    const wrong: number = "wrong";',
      "    const clean = 1;",
      "    return wrong + clean;",
      "}",
      "",
    ].join("\n");
    await writeTypeScriptProject(directory, fileName, source);

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-lsp-protocol",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-lsp-protocol",
              name: "read",
              arguments: { path: `lsp:${fileName}` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The LSP protocol read finished")]),
      ],
    }).run("Read only the lines with LSP errors");

    const rendered = getToolResultText(result, "read-lsp-protocol");
    expect(rendered).toContain('const wrong: number = "wrong"');
    expect(rendered).toContain("[ERROR] lsp:2322:");
    expect(rendered).toMatch(/2#[A-Z0-9]{4}\|/u);
    expect(rendered).not.toContain("const clean = 1");
    expect(rendered).not.toContain("return wrong + clean");

    const message = getToolResultMessage(result, "read-lsp-protocol");
    const details = message.details as { readonly source?: string };
    expect(details.source).toMatch(/^lsp:\/.*\/lsp-protocol\.ts$/u);
  });
}, 60_000);

test("symbol and graph sources expose layered LSP code views", async () => {
  await withTempDirectory(async (directory) => {
    const serviceName = "service.ts";
    const consumerName = "consumer.ts";
    const serviceSource = [
      "export class UserService {",
      "    constructor(private readonly prefix: string) {}",
      "",
      "    getUser(id: string): string {",
      "        return normalize(`${this.prefix}:${id}`);",
      "    }",
      "}",
      "",
      "export function normalize(value: string): string {",
      "    return value.trim();",
      "}",
      "",
      'export const version = "1";',
      "",
    ].join("\n");
    const consumerSource = [
      'import { UserService } from "./service.js";',
      "",
      "export function run(service: UserService): string {",
      '    return service.getUser("42");',
      "}",
      "",
      "export function start(): string {",
      '    return run(new UserService("user"));',
      "}",
      "",
    ].join("\n");
    await writeTypeScriptCodeViewProject(directory, {
      [serviceName]: serviceSource,
      [consumerName]: consumerSource,
    });

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-lsp-code-views",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-symbol-view",
              name: "read",
              arguments: { path: `symbol:${serviceName}#UserService/getUser` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-symbol-graph",
              name: "read",
              arguments: { path: `graph:${serviceName}#UserService/getUser` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-file-graph",
              name: "read",
              arguments: { path: `graph:${serviceName}` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-malformed-symbol-view",
              name: "read",
              arguments: { path: `symbol:${serviceName}` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-missing-symbol-view",
              name: "read",
              arguments: { path: `symbol:${serviceName}#UserService/missing` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The LSP code-view reads finished")]),
      ],
    }).run("Inspect one symbol and its symbol and file graphs");

    const symbol = getToolResultText(result, "read-symbol-view");
    expect(symbol).toContain("## symbol: UserService/getUser");
    expect(symbol).toContain("getUser(id: string): string");
    expect(symbol).toContain("return normalize(`${this.prefix}:${id}`);");
    expect(symbol).not.toContain("export function normalize");
    expect(symbol).toMatch(/4#[A-Z0-9]{4}\|    getUser/u);

    const symbolMessage = getToolResultMessage(result, "read-symbol-view");
    const symbolDetails = symbolMessage.details as { readonly source?: string };
    expect(symbolDetails.source).toMatch(/^symbol:\/.*\/service\.ts#UserService\/getUser$/u);

    const graph = getToolResultText(result, "read-symbol-graph");
    expect(graph).toContain("## graph: UserService/getUser");
    expect(graph).toContain("References:");
    expect(graph).toContain("consumer.ts");
    expect(graph).toContain("Incoming calls:");
    expect(graph).toContain("run");
    expect(graph).toContain("Outgoing calls:");
    expect(graph).toContain("normalize");

    const fileGraph = getToolResultText(result, "read-file-graph");
    expect(fileGraph).toContain("## file graph: service.ts");
    expect(fileGraph).toContain("### Class UserService");
    expect(fileGraph).toContain("### Function normalize");
    expect(fileGraph).toContain("### Variable version");
    expect(fileGraph).toContain("graph:service.ts#UserService/getUser");

    const malformed = getToolResultText(result, "read-malformed-symbol-view");
    expect(malformed).toContain("symbol: requires #<symbol-selector> after the file path.");

    const missing = getToolResultText(result, "read-missing-symbol-view");
    expect(missing).toContain('Symbol "UserService/missing" was not found in service.ts.');
  });
}, 60_000);

async function writeTypeScriptCodeViewProject(
  directory: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    path.join(configDirectory, "lsp-servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        "typescript-language-server": {
          command: [path.join(process.cwd(), "node_modules/.bin/tsc"), "--lsp", "--stdio"],
          rootMarkers: ["tsconfig.json"],
          languages: { typescript: { extensions: [".ts"] } },
          capabilities: ["diagnostics"],
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        noEmit: true,
        strict: true,
      },
      include: Object.keys(files),
    }),
    "utf8",
  );

  await Promise.all(
    Object.entries(files).map(([fileName, source]) =>
      writeFile(path.join(directory, fileName), source, "utf8"),
    ),
  );
}

async function writeTypeScriptProject(
  directory: string,
  fileName: string,
  source: string,
): Promise<void> {
  const configDirectory = path.join(directory, ".pi", "pi-agent-ide");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    path.join(configDirectory, "lsp-servers.json"),
    JSON.stringify({
      version: 1,
      servers: {
        "typescript-language-server": {
          command: [path.join(process.cwd(), "node_modules/.bin/tsc"), "--lsp", "--stdio"],
          rootMarkers: ["tsconfig.json"],
          languages: { typescript: { extensions: [".ts"] } },
          capabilities: ["diagnostics"],
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { noEmit: true, strict: true }, include: [fileName] }),
    "utf8",
  );
  await writeFile(path.join(directory, fileName), source, "utf8");
}

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "project-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

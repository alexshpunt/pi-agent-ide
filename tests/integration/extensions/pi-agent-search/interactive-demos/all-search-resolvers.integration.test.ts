import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const extensions = createExtensionSet();
const demoExtensions = [
  ...extensions.paths,
  path.resolve("src/extensions/pi-agent-search/plugins/pi-agent-search-semantic/index.ts"),
  path.resolve(
    "tests/integration/extensions/pi-agent-search/interactive-demos/fixtures/web-search-transport.ts",
  ),
  path.resolve("src/extensions/pi-agent-search/plugins/pi-agent-search-web/index.ts"),
  path.resolve("src/plugins/pi-agent-ide-lsp/index.ts"),
];
const interactivePacing =
  process.env.PI_INTEGRATION_TEST_LIVE === "1"
    ? {}
    : { chunks: { kind: "fixed" as const, size: 256 }, delayMs: 0 };
const calls = [
  { id: "search-text", query: "ResolverAtlas", resolverId: "text", arguments: { path: "src" } },
  {
    id: "search-regex",
    query: "regex:Resolver(?:Atlas|Summary)",
    resolverId: "regex",
    arguments: { path: "src", include: "**/*.ts" },
  },
  {
    id: "search-files",
    query: "files:search-demo",
    resolverId: "files",
    arguments: { path: "src", include: "**/*.ts" },
  },
  {
    id: "search-semantic",
    query: "semantic:protocol atlas",
    resolverId: "semantic",
    arguments: { limit: 3 },
  },
  {
    id: "search-web",
    query: "web:Pi Search resolver architecture",
    resolverId: "web",
    arguments: { limit: 3 },
  },
  {
    id: "search-lsp",
    query: "lsp:createResolverAtlas",
    resolverId: "lsp",
    arguments: { limit: 5 },
  },
  {
    id: "search-ast",
    query: "ast:createResolverAtlas()",
    resolverId: "ast",
    arguments: { path: "src" },
  },
] as const;

afterAll(() => extensions.dispose());

describe("interactive Search resolver demos", () => {
  test("shows every installed resolver through one Search tool", async () => {
    await withTempWorkspace(async (directory) => {
      await prepareWorkspace(directory);
      const conversation = calls.map((call) =>
        assistantMessage(
          [
            toolCall({
              id: call.id,
              name: "search",
              arguments: { query: call.query, ...call.arguments },
              ...interactivePacing,
            }),
          ],
          { stopReason: "toolUse" },
        ),
      );
      const result = await new PiIntegrationTest({
        testName: "interactive-demo-all-search-resolvers",
        cwd: directory,
        extensions: demoExtensions,
        tools: ["search"],
        rawMode: false,
        timeoutMs: 240_000,
        conversation: [
          ...conversation,
          assistantMessage([text("All seven Search resolvers completed", { delayMs: 0 })]),
        ],
      }).run("Demonstrate text, regex, file, semantic, web, LSP, and AST search through one tool");

      for (const call of calls) {
        const execution = getToolExecution(result, call.id);
        expect(execution.isError, call.id).toBe(false);
        expect(
          (getToolExecutionDetails(execution) as { resolverId?: string }).resolverId,
          call.id,
        ).toBe(call.resolverId);
        expect(getToolResultText(result, call.id).length, call.id).toBeGreaterThan(0);
        expect(result.tuiRenderedOutput).toContain(`search "${call.query}"`);
      }

      expect(getToolResultText(result, "search-semantic")).toContain("Search Resolver Corpus");
      expect(getToolResultText(result, "search-web")).toContain(
        "https://example.com/pi-search-resolvers",
      );
      expect(getToolResultText(result, "search-lsp")).toContain("createResolverAtlas");
      expect(getToolResultText(result, "search-ast")).toContain("createResolverAtlas()");
    });
  }, 240_000);
});

async function prepareWorkspace(directory: string): Promise<void> {
  const sourceDirectory = path.join(directory, "src");
  const corpusDirectory = path.join(directory, "corpus");
  const qmdDirectory = path.join(directory, ".qmd");
  const piDirectory = path.join(directory, ".pi");
  const ideConfigDirectory = path.join(piDirectory, "pi-agent-ide");
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(corpusDirectory, { recursive: true }),
    mkdir(qmdDirectory, { recursive: true }),
    mkdir(piDirectory, { recursive: true }),
    mkdir(ideConfigDirectory, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(sourceDirectory, "search-demo.ts"),
      [
        "export interface ResolverAtlas",
        "{",
        "    readonly ResolverSummary: string;",
        "}",
        "",
        "export function createResolverAtlas(): ResolverAtlas",
        "{",
        '    return { ResolverSummary: "all search protocols" };',
        "}",
        "",
        "export const resolverAtlas = createResolverAtlas();",
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      path.join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { noEmit: true, strict: true },
        include: ["src/**/*.ts"],
      }),
      "utf8",
    ),
    writeFile(
      path.join(ideConfigDirectory, "lsp-servers.json"),
      JSON.stringify({
        version: 1,
        servers: {
          "typescript-language-server": {
            command: [path.resolve("node_modules/.bin/tsc"), "--lsp", "--stdio"],
            rootMarkers: ["tsconfig.json"],
            languages: { typescript: { extensions: [".ts"] } },
            capabilities: ["diagnostics"],
          },
        },
      }),
      "utf8",
    ),
    writeFile(
      path.join(corpusDirectory, "search-resolvers.md"),
      [
        "# Search Resolver Corpus",
        "",
        "The protocol atlas explains how one Search tool routes every resolver.",
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      path.join(qmdDirectory, "index.yml"),
      [
        "collections:",
        "    demo:",
        `        path: ${corpusDirectory}`,
        '        pattern: "**/*.md"',
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      path.join(piDirectory, "websearch.json"),
      JSON.stringify({
        strategy: "priority",
        fallback: true,
        providers: [
          { id: "empty", provider: "serper", apiKey: "demo", maxResults: 3 },
          { id: "demo", provider: "duckduckgo-html", maxResults: 3 },
        ],
      }),
      "utf8",
    ),
  ]);

  await promisify(execFile)(
    path.resolve(
      "src/extensions/pi-agent-search/plugins/pi-agent-search-semantic/node_modules/.bin/qmd",
    ),
    ["update"],
    { cwd: directory },
  );
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const extensions = createExtensionSet();
const demoExtensions = [...extensions.paths, path.resolve("src/plugins/pi-agent-ide-lsp/index.ts")];
const searchOnlyExtensions = [
  path.resolve("src/extensions/pi-agent-search/index.ts"),
  path.resolve("src/extensions/pi-agent-search/plugins/pi-agent-search-text/index.ts"),
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
    id: "search-lsp",
    query: "symbols:createResolverAtlas",
    resolverId: "symbols",
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
          assistantMessage([text("All installed Search resolvers completed", { delayMs: 0 })]),
        ],
      }).run("Demonstrate text, regex, file, LSP, and AST search through one tool");

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

      expect(getToolResultText(result, "search-lsp")).toContain("createResolverAtlas");
      expect(getToolResultText(result, "search-ast")).toContain("createResolverAtlas()");
    });
  }, 240_000);
});

test("treats the former semantic prefix as ordinary literal text", async () => {
  await withTempWorkspace(async (directory) => {
    await prepareWorkspace(directory);
    await writeFile(
      path.join(directory, "src/former-prefix.txt"),
      "semantic:protocol atlas\n",
      "utf8",
    );

    const result = await new PiIntegrationTest({
      testName: "search-former-semantic-prefix-as-literal-text",
      cwd: directory,
      extensions: searchOnlyExtensions,
      tools: ["search"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-former-semantic-prefix",
              name: "search",
              arguments: { query: "semantic:protocol atlas", path: "src" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Search finished")]),
      ],
    }).run("Search for the complete literal text, including its former prefix");

    const execution = getToolExecution(result, "search-former-semantic-prefix");
    expect(execution.isError).toBe(false);
    expect((getToolExecutionDetails(execution) as { resolverId?: string }).resolverId).toBe("text");
    expect(getToolResultText(result, "search-former-semantic-prefix")).toContain(
      "semantic:protocol atlas",
    );
  });
});

test("uses literal-first fallback and Boolean text search through real Pi", async () => {
  await withTempWorkspace(async (directory) => {
    await prepareWorkspace(directory);
    await writeFile(
      path.join(directory, "src/search-query.txt"),
      [
        "pi install package locally",
        "install command alone",
        "npm configuration",
        "extension settings",
        "const MAX_RESULT_BYTES = 1024;",
        "const MAX_LOG_CHARS = 4000;",
        "wt -C /repo switch @",
        "wt --config custom.toml list",
        "providerError handled",
        "errorMessage handled",
        "providerError handled ignored",
      ].join("\n"),
      "utf8",
    );

    const searchCalls = [
      { id: "literal-first", query: "install package" },
      { id: "word-fallback", query: "npm extension absent" },
      { id: "boolean-or", query: "MAX_RESULT_BYTES OR MAX_LOG_CHARS" },
      { id: "boolean-flags", query: "-C OR --config" },
      { id: "boolean-invalid", query: "MAX_RESULT_BYTES OR" },
      {
        id: "boolean-combined",
        query: "(providerError OR errorMessage) AND handled NOT ignored",
      },
    ] as const;
    const result = await new PiIntegrationTest({
      testName: "search-literal-fallback-and-boolean-query",
      cwd: directory,
      extensions: searchOnlyExtensions,
      tools: ["search"],
      conversation: [
        ...searchCalls.map((call) =>
          assistantMessage(
            [
              toolCall({
                id: call.id,
                name: "search",
                arguments: { query: call.query, path: "src/search-query.txt" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Search finished")]),
      ],
    }).run("Exercise literal fallback and Boolean text searches");

    const literalResult = plainSearchResult(getToolResultText(result, "literal-first"));
    expect(literalResult).toContain("install package locally");
    expect(literalResult).not.toContain("install command alone");

    const fallbackResult = plainSearchResult(getToolResultText(result, "word-fallback"));
    expect(fallbackResult).toContain("npm configuration");
    expect(fallbackResult).toContain("extension settings");

    const rawOrResult = getToolResultText(result, "boolean-or");
    const orResult = plainSearchResult(rawOrResult);
    expect(orResult).toContain("MAX_RESULT_BYTES");
    expect(orResult).toContain("MAX_LOG_CHARS");
    expect(rawOrResult).toContain("⟦MAX_RESULT_BYTES⟧");
    expect(rawOrResult).toContain("⟦MAX_LOG_CHARS⟧");

    const flagResult = plainSearchResult(getToolResultText(result, "boolean-flags"));
    expect(flagResult).toContain("wt -C /repo switch @");
    expect(flagResult).toContain("wt --config custom.toml list");

    expect(getToolExecution(result, "boolean-invalid").isError).toBe(false);
    expect(getToolResultText(result, "boolean-invalid")).toContain(
      "Invalid Boolean search query at column 20: expected a term after OR.",
    );
    expect(getToolResultText(result, "boolean-invalid")).not.toContain("Resolver text failed");

    const combinedResult = plainSearchResult(getToolResultText(result, "boolean-combined"));
    expect(combinedResult).toContain("providerError handled");
    expect(combinedResult).toContain("errorMessage handled");
    expect(combinedResult).not.toContain("providerError handled ignored");

    for (const call of searchCalls) {
      expect(getToolExecution(result, call.id).isError, call.id).toBe(false);
    }
  });
});

test("wraps a long structured search line in the real native renderer", async () => {
  await withTempWorkspace(async (directory) => {
    await prepareWorkspace(directory);
    await writeFile(
      path.join(directory, "src/search-demo.ts"),
      `export const longResolverLine = "${"alpha beta ".repeat(30)}ResolverAtlas ${"https://example.com/".repeat(10)}";\n`,
      "utf8",
    );

    const result = await new PiIntegrationTest({
      testName: "search-word-wrap",
      cwd: directory,
      extensions: searchOnlyExtensions,
      tools: ["search"],
      rawMode: false,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "search-word-wrap",
              name: "search",
              arguments: { query: "ResolverAtlas", path: "src" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Search finished")]),
      ],
    }).run("Search the long source line");

    const rendered = stripTerminalSequences(result.terminalOutput);
    const panel = rendered.slice(rendered.indexOf("╭─ 1 match"));
    const panelRows = panel.split("\n").filter((row) => row.includes("│"));

    expect(getToolExecution(result, "search-word-wrap").isError).toBe(false);
    expect(getToolResultText(result, "search-word-wrap")).toContain("ResolverAtlas");
    expect(panelRows.length).toBeGreaterThan(2);
    expect(panel).toContain("ResolverAtlas");
    expect(panel).toContain("https://example.com/");
  });
});
function plainSearchResult(result: string): string {
  return result.replaceAll("⟦", "").replaceAll("⟧", "");
}

async function prepareWorkspace(directory: string): Promise<void> {
  const sourceDirectory = path.join(directory, "src");
  const piDirectory = path.join(directory, ".pi");
  const ideConfigDirectory = path.join(piDirectory, "pi-agent-ide");
  await Promise.all([
    mkdir(sourceDirectory, { recursive: true }),
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
  ]);
}

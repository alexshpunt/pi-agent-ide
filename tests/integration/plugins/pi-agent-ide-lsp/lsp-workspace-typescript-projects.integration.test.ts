import {
  PiIntegrationTest,
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import builtInServers from "#src/api/tool-config/lsp-servers.json" with { type: "json" };

const appScope = "frontend/src";
const seed = `${appScope}/00-tooling.d.ts`;
const roleSource = `${appScope}/composables/useRoleLabel.ts`;
const themeSource = `${appScope}/composables/useTheme.ts`;
const pluginPath = process.env.PI_TEST_VUE_TYPESCRIPT_PLUGIN_PATH;

async function writeFixture(cwd: string, files: Record<string, string>) {
  for (const [source, content] of Object.entries(files)) {
    const file = path.join(cwd, source);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
}

async function searchFrontend(vuePlugin?: string) {
  return withTempWorkspace(async (cwd) => {
    const app = `${appScope}/App.${vuePlugin === undefined ? "ts" : "vue"}`;
    const script = [
      'import { useRoleLabel } from "@/composables/useRoleLabel";',
      "const role = useRoleLabel();",
    ].join("\n");
    await writeFixture(cwd, {
      "go.mod": "module example.com/repro\n\ngo 1.24\n",
      "frontend/tsconfig.json": JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.node.json" }, { path: "./tsconfig.app.json" }],
      }),
      "frontend/tsconfig.node.json": JSON.stringify({
        compilerOptions: { composite: true },
        files: ["src/00-tooling.d.ts"],
      }),
      "frontend/tsconfig.app.json": JSON.stringify({
        compilerOptions: {
          composite: true,
          strict: true,
          paths: { "@/*": ["./src/*"] },
        },
        include: ["src/**/*", "src/**/*.vue"],
        exclude: ["src/00-tooling.d.ts"],
      }),
      [seed]: "export declare const toolingOnly: unique symbol;\n",
      [app]:
        vuePlugin === undefined
          ? `${script}\nexport { role };\n`
          : `<script setup lang="ts">\n${script}\n</script>\n<template>{{ role }}</template>\n`,
      [roleSource]: 'export function useRoleLabel() { return "admin"; }\n',
      [themeSource]: 'export function initTheme() { return "dark"; }\n',
      ...(vuePlugin !== undefined && {
        ".pi/pi-agent-ide/lsp-servers.json": JSON.stringify({
          version: 1,
          servers: {
            "vue-typescript-language-server": {
              ...builtInServers.servers["vue-typescript-language-server"],
              initializationOptions: {
                plugins: [
                  { name: "@vue/typescript-plugin", location: vuePlugin, languages: ["vue"] },
                ],
              },
            },
          },
        }),
      }),
    });
    const calls = [
      { id: "theme", query: "initTheme" },
      { id: "role", query: "useRoleLabel" },
    ];
    const run = await new PiIntegrationTest({
      testName:
        vuePlugin === undefined ? "workspace-typescript-projects" : "workspace-vue-projects",
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename),
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["lsp_search"],
      timeoutMs: 120_000,
      conversation: [
        ...calls.map(({ id, query }) =>
          assistantMessage(
            [toolCall({ id, name: "lsp_search", arguments: { query, path: appScope } })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Find initTheme and useRoleLabel in the frontend sources");

    function hitsOf(id: string) {
      const execution = getToolExecution(run, id);
      expect(execution.isError, getToolResultText(run, id)).toBe(false);
      const { payload } = getToolExecutionDetails(execution) as {
        payload: {
          cwd: string;
          complete: boolean;
          hits: {
            source: string;
            role: string;
            lineNumber: number;
            matchedText: string;
            symbol: { source: string };
          }[];
        };
      };
      expect(payload.complete).toBe(true);
      const relative = (source: string) =>
        path.relative(payload.cwd, source).split(path.sep).join("/");
      return payload.hits.map(({ source, role, lineNumber, matchedText, symbol }) => ({
        source: relative(source),
        role,
        line: lineNumber,
        text: matchedText,
        declaration: relative(symbol.source),
      }));
    }

    const themeHits = hitsOf("theme");
    expect.soft(themeHits).toEqual([
      {
        source: themeSource,
        role: "definition",
        line: 1,
        text: "initTheme",
        declaration: themeSource,
      },
    ]);
    const roleHits = hitsOf("role");
    expect.soft(roleHits.filter(({ role }) => role === "definition")).toEqual([
      {
        source: roleSource,
        role: "definition",
        line: 1,
        text: "useRoleLabel",
        declaration: roleSource,
      },
    ]);
    // A reference can sit one directory above its TypeScript declaration.
    const appLine = vuePlugin === undefined ? 1 : 2;
    expect.soft(roleHits.filter(({ source }) => source === app)).toEqual(
      [appLine, appLine + 1].map((line) => ({
        source: app,
        role: "reference",
        line,
        text: "useRoleLabel",
        declaration: roleSource,
      })),
    );
  });
}

test("finds an unopened TypeScript project when the directory also contains tooling sources", async () => {
  await searchFrontend();
}, 150_000);

test.skipIf(pluginPath === undefined)(
  "finds Vue imports as references to their TypeScript declarations",
  async () => {
    await searchFrontend(pluginPath);
  },
  150_000,
);

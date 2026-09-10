import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { BUILTIN_EXTENSIONS } from "#src/composite/builtin-extensions.js";

// Missing disabled module files make eager evaluation fail at Pi's real loader boundary.
test("loads only selected built-ins and leaves disabled dependencies unevaluated", async () => {
  const parent = path.resolve(".agents/tmp/lazy-builtins");
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(path.join(parent, "project-"));
  try {
    await mkdir(path.join(cwd, "src/composite"), { recursive: true });
    await mkdir(path.join(cwd, "src/tips"), { recursive: true });
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ type: "module", imports: { "#src/*.js": "./src/*.ts" } }),
    );
    for (const file of [
      "src/pi-agent-ide.ts",
      "src/composite/builtin-extensions.ts",
      "src/composite/selection.ts",
      "src/composite/extensions-config.ts",
      "src/composite/feature-flags.ts",
      "src/composite/module-labels.ts",
      "src/composite/module-settings.ts",
      "src/composite/module-settings-store.ts",
      "src/composite/settings-panel.ts",
    ]) {
      await copyFile(path.resolve(file), path.join(cwd, file));
    }
    await writeFile(
      path.join(cwd, "src/tips/extension.ts"),
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(path.join(cwd, "loaded.txt"))}, "loaded\\n");\nexport default async function register() { appendFileSync(${JSON.stringify(path.join(cwd, "loaded.txt"))}, "registered\\n"); }\n`,
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        // AST is not explicitly disabled, but its disabled core must prevent its import.
        disabled: BUILTIN_EXTENSIONS.filter(
          (item) => !["ide.tips", "ide.ast"].includes(item.id),
        ).map((item) => item.id),
      }),
    );
    await new PiIntegrationTest({
      testName: "lazy-builtins",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.join(cwd, "src/pi-agent-ide.ts")],
      tools: [],
      conversation: [assistantMessage([text("Loaded selected extensions.")])],
    }).run("Finish without using tools.");
    expect(await readFile(path.join(cwd, "loaded.txt"), "utf8")).toBe("loaded\nregistered\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("the reduced text configuration keeps AST, anchors and edits working", async () => {
  const parent = path.resolve(".agents/tmp/lazy-builtins");
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(path.join(parent, "text-"));
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        disabled: [
          "ide.tips",
          "ide.doctor",
          "ide.languages",
          "read.filesystem.image",
          "read.filesystem.pdf",
          "read.web",
          "ide.formatter",
          "ide.lint",
          "ide.changes",
          "ide.lsp",
          "ide.diagnostics",
        ],
        noAnimations: true,
        noPostProcessing: true,
      }),
    );
    const source = "export function total(value: number) {\n  return value + 1;\n}\n";
    await writeFile(path.join(cwd, "example.ts"), source);
    const call = (id: string, name: string, args: Record<string, unknown>) =>
      assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
    const result = await new PiIntegrationTest({
      testName: "lazy-builtins-text-ast",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read", "insert"],
      conversation: [
        call("ast", "read", { path: "ast:example.ts" }),
        call("anchors", "read", { path: "example.ts", views: ["anchors"] }),
        call("insert", "insert", {
          path: "example.ts",
          anchor: "  return value + 1;",
          text: "  // Keep the increment.\n",
          before: true,
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Inspect the function and insert the supplied comment.");
    for (const id of ["ast", "anchors", "insert"])
      expect(getToolExecution(result, id).isError).toBe(false);
    expect(getToolResultText(result, "ast")).toContain("total");
    expect(getToolResultText(result, "anchors")).toMatch(/1#[A-Z0-9]+\|/u);
    expect(await readFile(path.join(cwd, "example.ts"), "utf8")).toBe(
      source.replace("  return", "  // Keep the increment.\n  return"),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);

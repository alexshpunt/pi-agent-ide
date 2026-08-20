import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getProviderSystemPrompt,
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
  "src/plugins/pi-agent-ide-ast/index.ts",
]);
const tempRoot = path.resolve(".tmp/pi-agent-ast");

afterAll(async () => {
  await generatedExtensions.dispose();
  await rm(tempRoot, { recursive: true, force: true });
});

test("read shows AST scope markers without changing the source", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "scope-markers.js";
    const file = path.join(directory, fileName);
    const source = [
      "export function logValue() {",
      "    const value = 1;",
      "    return value;",
      "    console.log(value);",
      "}",
      "",
    ].join("\n");
    await writeFile(file, source, "utf8");

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-ast-scope-markers",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-ast-scope-markers",
              name: "read",
              arguments: { path: fileName },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The AST scope read finished")]),
      ],
    }).run("Read the source and inspect its AST scope markers");

    expect(await readFile(file, "utf8")).toBe(source);

    const rendered = getToolResultText(result, "read-ast-scope-markers");
    expect(rendered).toContain("export function logValue() {  <!-- scope-begin-");
    expect(rendered).toContain("}  <!-- scope-end-");

    const message = getToolResultMessage(result, "read-ast-scope-markers");
    const details = message.details as {
      readonly lines?: readonly { readonly lineNumber: number; readonly content: string }[];
    };
    expect(details.lines?.map((line) => line.lineNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(details.lines?.[0]?.content).toBe("export function logValue() {");

    const prompt = getProviderSystemPrompt(result);
    expect(prompt).toContain("prefer `ast:<path>` for the first read");
  });
}, 60_000);

test("ast source returns a compressed outline with original file anchors", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "outline.ts";
    const file = path.join(directory, fileName);
    const source = [
      "export class UserService {",
      '    private token = "hidden";',
      "    getUser(id: string): string {",
      "        return `${this.token}:${id}`;",
      "    }",
      "}",
      "",
      "export function unrelated(): void {",
      '    console.log("hidden implementation");',
      "}",
      "",
    ].join("\n");
    await writeFile(file, source, "utf8");

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-ast-outline-source",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-ast-outline-source",
              name: "read",
              arguments: { path: `ast:${fileName}` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The AST outline read finished")]),
      ],
    }).run("Read the compressed AST outline");

    const rendered = getToolResultText(result, "read-ast-outline-source");
    expect(rendered).toContain("## file: outline.ts");
    expect(rendered).toContain("export class UserService");
    expect(rendered).toContain("private token = …");
    expect(rendered).toContain("getUser(id: string): string");
    expect(rendered).not.toContain("this.token");
    expect(rendered).not.toContain("hidden implementation");
    expect(rendered).toMatch(/1#[A-Z0-9]{4}\|export class UserService/u);
    expect(rendered).toContain("<!-- scope-begin-");

    const message = getToolResultMessage(result, "read-ast-outline-source");
    const details = message.details as { readonly source?: string };
    expect(details.source).toMatch(/^ast:\/.*\/outline\.ts$/u);

    const prompt = getProviderSystemPrompt(result);
    expect(prompt).toContain("`ast:<path>`");
  });
}, 60_000);

test("range projection keeps only selected source lines and their visible markers", async () => {
  await withTempDirectory(async (directory) => {
    const fileName = "range.js";
    await writeFile(
      path.join(directory, fileName),
      ["function work() {", "    first();", "    second();", "    third();", "}"].join("\n"),
      "utf8",
    );

    const result = await new PiIntegrationTest({
      artifactsDir: testArtifactsDir(expect.getState().testPath),
      testName: "read-ast-scope-markers-range",
      cwd: directory,
      extensions: generatedExtensions.paths,
      tools: ["read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read-ast-scope-markers-range",
              name: "read",
              arguments: { path: fileName, offset: 1, limit: 1 },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("The AST scope range read finished")]),
      ],
    }).run("Read the first source line");

    const rendered = getToolResultText(result, "read-ast-scope-markers-range");
    expect(rendered).toContain("function work() {  <!-- scope-begin-");
    expect(rendered).toContain("}  <!-- scope-end-");
    expect(rendered).not.toContain("first();");

    const message = getToolResultMessage(result, "read-ast-scope-markers-range");
    const details = message.details as {
      readonly lines?: readonly { readonly lineNumber: number }[];
    };
    expect(details.lines?.map((line) => line.lineNumber)).toEqual([1, 5]);
  });
}, 60_000);

async function withTempDirectory(callback: (directory: string) => Promise<void>): Promise<void> {
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "project-"));

  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

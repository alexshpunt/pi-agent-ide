import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { currentIde } from "./fixtures/current-ide.ts";
import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const id = "20000000-0000-4000-8000-000000000002";
const doc = (body: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
});
test.each([
  ["issue", false],
  ["document", false],
  ["issue", true],
  ["document", true],
] as const)(
  "creates and edits a native %s template through real resource tools (provider first: %s)",
  async (type, providerFirst) => {
    const ide = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp", "template-create-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(
        path.join(cwd, ".pi/linear.json"),
        JSON.stringify({ axiPath: path.join(root, "tests/fixtures/template-create-axi.mjs") }),
      );
      const source = "linear://example/workflow-template/new";
      const selected = `linear://example/workflow-template/${id}`;
      const operations: [string, string, Record<string, unknown>][] = [
        ["schema", "read", { path: source }],
        [
          "create",
          "write",
          {
            path: source,
            content: JSON.stringify({
              name: `ENG-751 disposable ${type}`,
              type,
              descriptionData: doc("Fixture body"),
            }),
          },
        ],
        ["created", "read", { path: selected }],
        ["discovery", "read", { path: selected + "#schema" }],
        ["fields", "read", { path: selected + "#fields" }],
        [
          "update",
          "write",
          {
            path: selected + "#fields",
            content: JSON.stringify({ descriptionData: doc("Updated fixture body") }),
          },
        ],
        ["updated", "read", { path: selected }],
        ["legacy", "read", { path: `linear://example/template/${id}` }],
        [
          "uncertain",
          "write",
          {
            path: source,
            content: JSON.stringify({
              name: "Uncertain fixture",
              type,
              descriptionData: doc("Unknown body"),
            }),
          },
        ],
        [
          "override",
          "write",
          {
            path: source,
            content: JSON.stringify({
              id,
              name: "Rejected",
              type,
              descriptionData: doc("Unwanted body"),
            }),
          },
        ],
      ];
      const linear = path.join(root, "src/index.ts");
      const result = await new PiIntegrationTest({
        testName: `linear-template-create-${type}-${providerFirst ? "provider" : "core"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        extensions: providerFirst ? [linear, ide.extension] : [ide.extension, linear],
        tools: ["read", "write"],
        rawMode: false,
        timeoutMs: 60000,
        conversation: [
          ...operations.map(([id, name, args]) =>
            assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
          ),
          assistantMessage([text("Finished.")]),
        ],
      }).run(
        "Create a labelled disposable template and edit its content without changing its identity.",
      );
      await ide.record(result.artifacts.directory);
      for (const [name] of operations.filter(([name]) => !["override", "uncertain"].includes(name)))
        expect(getToolExecution(result, name).isError, getToolResultText(result, name)).toBe(false);
      expect(getToolExecution(result, "override").isError).toBe(true);
      expect(getToolExecution(result, "uncertain").isError).toBe(true);
      expect(getToolResultText(result, "uncertain")).toContain(
        "linear://example/workflow-template/20000000-0000-4000-8000-000000000003",
      );
      expect(getToolResultText(result, "create")).toContain(id);
      expect(getToolResultText(result, "create")).toContain("create_workflow_template");
      expect(getToolResultText(result, "created")).toContain("Fixture body");
      expect(getToolResultText(result, "discovery")).toContain(source);
      expect(getToolResultText(result, "discovery")).not.toContain(selected + "#new");
      expect(getToolResultText(result, "updated")).toContain("Updated fixture body");
      expect(getToolResultText(result, "legacy")).toContain(id);
      const saved = JSON.parse(await readFile(path.join(cwd, "template-fixture.json"), "utf8")) as {
        id: string;
        type: string;
        templateData: string;
      };
      expect(saved.id).toBe(id);
      expect(saved.type).toBe(type);
      expect(JSON.parse(saved.templateData)).toMatchObject({
        descriptionData: doc("Updated fixture body"),
      });
      const calls: string[][] = (await readFile(path.join(cwd, "axi-calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(calls.filter((args) => args[2] === "create_workflow_template")).toHaveLength(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  75000,
);

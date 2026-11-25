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
import { readTextData } from "./fixtures/read-data.ts";
import { textLineAnchors } from "pi-agent-ide/api/text";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const body = "linear://example/document/71000000-0000-4000-8000-000000000006/content";
const issue = "linear://example/issue/ENG-12";
const comment = `${issue}/comment/33333333-3333-4333-8333-333333333333#body`;

// Exercise the actual package loader, progressive disclosure and ordinary field editors.
test.each([false, true])(
  "loads and edits Linear fields with progressive guides (providerFirst=%s)",
  async (providerFirst) => {
    const ide = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp", "loading-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(
        path.join(cwd, ".pi/linear.json"),
        JSON.stringify({ axiPath: path.join(root, "tests/fixtures/axi.mjs") }),
      );
      const linear = path.join(root, "src/index.ts");
      const operations: [string, string, Record<string, unknown>][] = [
        ["guides", "read", { path: "docs:" }],
        ["body", "read", { path: body }],
        ["domain", "read", { path: "docs:linear-issues" }],
        ["status", "read", { path: `${issue}#status`, views: ["anchors"] }],
        ["save-status", "write", { path: `${issue}#status`, content: "In Progress" }],
        ["labels", "read", { path: `${issue}#labels` }],
        ["add-label", "insert", { path: `${issue}#labels`, after: "end", text: "Feature" }],
        ["add-existing-label", "insert", { path: `${issue}#labels`, after: "end", text: "Bug" }],
        ["verify", "read", { path: `${issue}#fields` }],
        ["comment", "read", { path: comment, views: ["anchors"] }],
        [
          "edit-comment",
          "replace",
          { path: comment, at: "Original comment", text: "Changed comment" },
        ],
        ["verify-comment", "read", { path: comment }],
        [
          "create",
          "write",
          {
            path: "linear://example/issue/new",
            content: JSON.stringify({ team: "ENG", title: "Created fixture" }),
          },
        ],
      ];
      const result = await new PiIntegrationTest({
        testName: `linear-loading-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: providerFirst ? [linear, ide.extension] : [ide.extension, linear],
        tools: ["read", "write", "insert", "replace"],
        timeoutMs: 60000,
        conversation: [
          ...operations.map(([id, name, args]) =>
            assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
          ),
          assistantMessage([text("Finished.")]),
        ],
      }).run(
        "Read the selected guide, edit fields without changing the body, then create an issue.",
      );
      await ide.record(result.artifacts.directory);
      for (const [id] of operations)
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      const documentation = (id: string) =>
        (
          getToolExecution(result, id).result as {
            details?: { documentation?: { kind: string; ids?: string[]; id?: string } };
          }
        ).details?.documentation;
      expect(documentation("guides")?.ids).toEqual(
        expect.arrayContaining(["linear", "linear-issues", "linear-files", "linear-review"]),
      );
      expect(documentation("body")).toMatchObject({ kind: "attachment" });
      expect(documentation("body")?.ids?.filter((id) => id.startsWith("linear"))).toEqual([
        "linear",
      ]);
      expect(documentation("domain")).toMatchObject({ kind: "document", id: "linear-issues" });
      expect(documentation("status")?.ids ?? []).toEqual([]);
      expect(getToolResultText(result, "body")).toContain("Full document");
      expect(readTextData(result, "status").lines[0]?.anchors).toContain(
        textLineAnchors(`${issue}#status`, "Todo")[0],
      );
      expect(getToolResultText(result, "verify")).toContain("In Progress");
      expect(getToolResultText(result, "verify")).toContain("Feature");
      expect(readTextData(result, "comment").lines[0]?.anchors).toContain(
        textLineAnchors(comment, "Original comment")[0],
      );
      expect(getToolResultText(result, "verify-comment")).toContain("Changed comment");
      expect(getToolResultText(result, "create")).toContain("linear://example/issue/ENG-99");
      const saved: unknown = JSON.parse(
        await readFile(path.join(cwd, "field-fixture.json"), "utf8"),
      );
      expect(saved).toMatchObject({ description: "Unchanged body", labels: ["Feature", "Bug"] });
      expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
      expect(result.tuiRenderedOutput).not.toContain("already handles");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);

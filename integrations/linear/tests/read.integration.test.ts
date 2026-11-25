import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
const linearExtension = path.join(root, "src/index.ts");
const source = "https://linear.app/example/issue/ENG-12/fixture-task";

// Pattern: the extension example drives real tools with scripted assistant responses.
// Contract: a separately loaded provider owns Linear URLs, returns source lines, and refuses failures.
test.each([false, true])(
  "reads through the shared tool in either load order (providerFirst=%s)",
  async (providerFirst) => {
    const ide = await currentIde();
    const readExtension = ide.extension;
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const workspace = await mkdtemp(path.join(root, ".tmp", "read-"));
    try {
      await mkdir(path.join(workspace, ".pi"));
      await writeFile(
        path.join(workspace, ".pi/linear.json"),
        JSON.stringify({
          axiPath: path.join(root, "tests/fixtures/axi.mjs"),
        }),
      );
      const result = await new PiIntegrationTest({
        testName: `linear-read-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: workspace,
        isolateUserResources: true,
        extensions: providerFirst
          ? [linearExtension, readExtension, path.join(root, "tests/fixtures/generic-web.ts")]
          : [readExtension, path.join(root, "tests/fixtures/generic-web.ts"), linearExtension],
        tools: ["read"],
        timeoutMs: 45000,
        conversation: [
          assistantMessage([toolCall({ id: "issue", name: "read", arguments: { path: source } })], {
            stopReason: "toolUse",
          }),
          assistantMessage(
            [
              toolCall({
                id: "range",
                name: "read",
                arguments: { path: source, offset: 20, limit: 1 },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "unsupported",
                name: "read",
                arguments: { path: "https://linear.app/example/project/project-id" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "denied",
                name: "read",
                arguments: { path: source.replace("ENG-12", "ENG-13") },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "web",
                name: "read",
                arguments: { path: "https://example.org/page" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "document",
                name: "read",
                arguments: {
                  path: "linear://example/document/71000000-0000-4000-8000-000000000006",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "native-document",
                name: "read",
                arguments: {
                  path: "https://linear.app/example/document/original-request-1234abcd5678",
                  offset: 6,
                  limit: 1,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          ...[
            ["team", "https://linear.app/example/team/ENG/overview"],
            ["issues", "https://linear.app/example/team/ENG/all"],
            ["projects", "https://linear.app/example/team/ENG/projects/all"],
            ["project", "https://linear.app/example/project/fixture-ab12cd34ef56/overview"],
            ["next", "https://linear.app/example/team/ENG/all?cursor=next%2Fpage"],
            ["wrong-workspace", "https://linear.app/other/team/ENG/all"],
          ].map(([id, path]) =>
            assistantMessage([toolCall({ id, name: "read", arguments: { path } })], {
              stopReason: "toolUse",
            }),
          ),
          assistantMessage([text("Finished.")]),
        ],
      }).run("Read the Linear issue, then inspect the range and failures.");
      await ide.record(result.artifacts.directory);
      expect(getToolExecution(result, "issue").isError).toBe(false);
      expect(getToolResultText(result, "issue")).toContain("Fixture project");
      expect(getToolResultText(result, "issue")).toContain("[0.3] Fixture: task");
      expect(getToolResultText(result, "issue")).toContain("Second line");
      expect(getToolResultText(result, "range")).toContain("First line");
      expect(getToolResultText(result, "range")).not.toContain("Second line");
      expect(getToolExecution(result, "unsupported").isError).toBe(true);
      expect(getToolExecution(result, "denied").isError).toBe(true);
      expect(getToolResultText(result, "denied")).toContain("LINEAR_AUTH_REQUIRED");
      expect(getToolResultText(result, "denied")).not.toContain("private-fixture-token");
      expect(getToolResultText(result, "web")).toContain("Generic web content");
      expect(getToolResultText(result, "issue")).toContain(
        "linear://example/document/71000000-0000-4000-8000-000000000006",
      );
      expect(getToolResultText(result, "issue")).toContain("https://example.org/pull/1");
      expect(getToolExecution(result, "document").isError).toBe(false);
      expect(getToolResultText(result, "document")).toContain("Full document");
      expect(getToolResultText(result, "native-document")).toContain("Full document");
      expect(getToolResultText(result, "native-document")).not.toContain("Last line");
      for (const id of ["team", "issues", "projects", "project", "next"]) {
        expect(getToolExecution(result, id).isError).toBe(false);
      }
      expect(getToolResultText(result, "team")).toContain("Pinned resources are not exposed");
      expect(getToolResultText(result, "issues")).toContain("?cursor=next%2Fpage");
      expect(getToolResultText(result, "next")).toContain("End of list");
      expect(getToolResultText(result, "projects")).toContain(
        "https://linear.app/example/project/fixture-ab12cd34ef56",
      );
      expect(getToolResultText(result, "project")).toContain("Last description line");
      expect(getToolResultText(result, "project")).toContain(
        "https://linear.app/example/document/original-request-1234abcd5678",
      );
      expect(getToolExecution(result, "wrong-workspace").isError).toBe(true);
      expect(getToolResultText(result, "wrong-workspace")).toContain("LINEAR_IDENTITY_MISMATCH");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
  60000,
);

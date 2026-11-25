import { currentIde } from "./fixtures/current-ide.ts";
import { readTextData } from "./fixtures/read-data.ts";
import { textLineAnchors } from "pi-agent-ide/api/text";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const fixture = path.join(root, "tests/fixtures/text-create-proof.ts");
const source = "linear://example/document/71000000-0000-4000-8000-000000000006/content";

// Pattern: extensions example, real shared editors over the production Linear text backend.
// Contract: changing asset signatures cannot stale anchors or selected edits; real edits still conflict.
test("edits signed asset bodies without losing stale-content protection", async () => {
  const ide = await currentIde();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/signed-assets-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "linear-signed-asset-edits",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [ide.extension, path.join(root, "tests/fixtures/signed-asset-proof.ts")],
      tools: ["read", "search", "replace", "verify_signed_asset_edits"],
      timeoutMs: 60000,
      conversation: [
        assistantMessage(
          [toolCall({ id: "signed-proof", name: "verify_signed_asset_edits", arguments: {} })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Finished.")]),
      ],
    }).run("Read and edit a Linear description whose asset signature changes on every read.");
    await ide.record(result.artifacts.directory);
    expect(
      getToolExecution(result, "signed-proof").isError,
      getToolResultText(result, "signed-proof"),
    ).toBe(false);
    expect(getToolExecutionDetails(getToolExecution(result, "signed-proof"))).toMatchObject({
      updates: 3,
    });
    expect(await readFile(path.join(cwd, "body.md"), "utf8")).toBe("External\nLast line\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);

// Pattern: extensions example, real umbrella tools with a deterministic source fixture.
// Contract: shared Write returns a created identity, then Read and ordinary editor use its body.
test.each([false, true])(
  "creates through Write and edits the returned resource (providerFirst=%s)",
  async (providerFirst) => {
    const ide = await currentIde();
    const extension = ide.extension;
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/write-"));
    try {
      const result = await new PiIntegrationTest({
        testName: `linear-create-${providerFirst ? "provider-first" : "core-first"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        extensions: providerFirst ? [fixture, extension] : [extension, fixture],
        tools: ["write", "read", "search", "replace", "verify_editor_scope"],
        timeoutMs: 60000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "create",
                name: "write",
                arguments: {
                  path: "linear://example/issue/ENG-12/documents/new?title=Workpad",
                  content: "First line\nLast line\n",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "read",
                name: "read",
                arguments: { path: source, views: ["anchors"] },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "edit",
                name: "replace",
                arguments: { path: source, at: "First line", text: "Changed" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [toolCall({ id: "verify", name: "read", arguments: { path: source } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [toolCall({ id: "scope", name: "verify_editor_scope", arguments: {} })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "unknown",
                name: "write",
                arguments: {
                  path: "linear://example/issue/ENG-12/documents/new?title=Workpad",
                  content: "simulate-unknown",
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Finished.")]),
        ],
      }).run("Create the Linear artifact through Write, then read and edit its payload link.");
      await ide.record(result.artifacts.directory);
      expect(getToolExecution(result, "create").isError).toBe(false);
      expect(getToolResultText(result, "create")).toContain(source);
      expect(getToolResultText(result, "create")).toContain(
        "https://linear.app/example/document/workpad-1234abcd5678",
      );
      expect(getToolExecution(result, "read").isError).toBe(false);
      expect(readTextData(result, "read").lines[0]?.anchors).toContain(
        textLineAnchors(source, "First line\nLast line\n")[0],
      );
      expect(getToolExecution(result, "edit").isError).toBe(false);
      expect(getToolResultText(result, "verify")).toContain("Changed");
      expect(getToolExecution(result, "scope").isError, getToolResultText(result, "scope")).toBe(
        false,
      );
      expect(getToolExecutionDetails(getToolExecution(result, "scope"))).toMatchObject({
        staleRejected: true,
      });
      expect(getToolExecution(result, "unknown").isError).toBe(true);
      expect(getToolExecutionDetails(getToolExecution(result, "unknown"))).toMatchObject({
        effect: "unknown",
      });
      expect(getToolResultText(result, "unknown")).not.toContain("private-fixture-token");
      expect(await readFile(path.join(cwd, "created-body.txt"), "utf8")).toBe(
        "External change\nLast line\n",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);

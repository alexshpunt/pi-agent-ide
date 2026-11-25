import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const documentId = "11111111-1111-4111-8111-111111111111";
const document = `linear://example/document/${documentId}`;
const body = `${document}/content`;
const unknownId = "33333333-3333-4333-8333-333333333333";
const unknownBody = `linear://example/document/${unknownId}/content`;
const collection = "linear://example/issue/ENG-12#attachments";
const bytes = Buffer.from([0, 255, 17, 42, 10]);

// Pattern: the extensions example and standalone.integration.test.ts.
// Contract: registered standalone tools reach shared body/artifact/upload handlers and preserve effects.
test("standalone body, artifact, upload and deletion actions preserve their real handler contracts", async () => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/standalone-actions-"));
  try {
    await writeFile(path.join(cwd, "report.bin"), bytes);
    await writeFile(path.join(cwd, "uncertain.bin"), bytes);
    const calls: [string, string, Record<string, unknown>][] = [
      ["discover", "tool_search", { query: "linear", limit: 20 }],
      ["body", "linear_read", { path: body, views: ["anchors"] }],
      ["replace", "linear_replace", { path: body, start: "Beta", text: "Changed" }],
      ["read-replaced", "linear_read", { path: body }],
      ["insert", "linear_insert", { path: body, anchor: "Changed", text: "Added" }],
      ["read-inserted", "linear_read", { path: body }],
      ["delete-text", "linear_delete", { path: body, start: "Added", end: "Added" }],
      ["read-deleted", "linear_read", { path: body }],
      ["link", "linear_copy", { path: document, target: collection }],
      ["rename", "linear_move", { path: document, target: `${document}?title=Renamed%20fixture` }],
      ["verify-body", "linear_read", { path: body }],
      [
        "invalid-rename",
        "linear_move",
        { path: document, target: `linear://example/document/${unknownId}?title=Wrong` },
      ],
      [
        "wrong-workspace",
        "linear_copy",
        { path: `linear://other/document/${documentId}`, target: collection },
      ],
      [
        "upload",
        "linear_upload",
        { file: "report.bin", workspace: "example", issue: "ENG-12", title: "Fixture file" },
      ],
      [
        "upload-unknown",
        "linear_upload",
        { file: "uncertain.bin", workspace: "example", issue: "ENG-12" },
      ],
      [
        "upload-wrong-parent",
        "linear_upload",
        {
          file: "report.bin",
          workspace: "example",
          issue: "https://linear.app/other/issue/ENG-12/wrong",
        },
      ],
      ["delete-refused", "linear_delete", { path: "linear://example/comment/refuse" }],
      ["delete-allowed", "linear_delete", { path: "linear://example/comment/allowed" }],
      ["delete-unknown", "linear_delete", { path: "linear://example/comment/unknown" }],
      ["read-unknown", "linear_read", { path: unknownBody }],
      ["body-unknown", "linear_replace", { path: unknownBody, start: "Original", text: "Changed" }],
      ["inspect-unknown", "linear_read", { path: unknownBody }],
    ];
    const result = await new PiIntegrationTest({
      testName: "linear-standalone-actions",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      extensions: ["builtin:tool-search", path.join(root, "tests/fixtures/standalone-actions.ts")],
      tools: ["tool_search", "linear_upload"],
      timeoutMs: 60_000,
      conversation: [
        ...calls.map(([id, name, args]) =>
          assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
        ),
        assistantMessage([text("Finished fixture actions.")]),
      ],
    }).run(
      "Exercise only the local standalone fixture; do not access a real Linear workspace or replay uncertain effects.",
    );
    const failures = new Set([
      "invalid-rename",
      "wrong-workspace",
      "upload-unknown",
      "upload-wrong-parent",
      "delete-refused",
      "delete-unknown",
      "body-unknown",
    ]);
    for (const [id] of calls)
      expect(
        Boolean(getToolExecution(result, id).isError),
        `${id}: ${getToolResultText(result, id)}`,
      ).toBe(failures.has(id));
    expect(getToolResultText(result, "read-replaced")).toBe("Alpha\nChanged\nGamma\n");
    expect(getToolResultText(result, "read-inserted")).toBe("Alpha\nChanged\nAdded\nGamma\n");
    expect(getToolResultText(result, "read-deleted")).toBe("Alpha\nChanged\nGamma\n");
    expect(getToolResultText(result, "verify-body")).toBe("Alpha\nChanged\nGamma\n");
    expect(getToolResultText(result, "link")).toContain("applied");
    expect(getToolResultText(result, "rename")).toContain("applied");
    expect(getToolResultText(result, "invalid-rename")).toContain("LINEAR_INVALID_DOCUMENT_RENAME");
    expect(getToolResultText(result, "wrong-workspace")).toContain("LINEAR_IDENTITY_MISMATCH");
    expect(getToolResultText(result, "delete-refused")).toContain("LINEAR_CONFIRMATION_REQUIRED");
    expect(getToolResultText(result, "body-unknown")).toContain("Effect: unknown");
    expect(getToolResultText(result, "inspect-unknown")).toBe("Changed unknown\n");
    expect(getToolResultText(result, "upload-unknown")).toContain("Outcome is uncertain");
    expect(getToolResultText(result, "upload-unknown")).toContain("Asset:");
    expect(getToolResultText(result, "upload-wrong-parent")).toContain("LINEAR_IDENTITY_MISMATCH");
    expect(getToolExecutionDetails(getToolExecution(result, "upload"))).toMatchObject({
      effect: "applied",
      receipt: {
        workspace: "example",
        upload: "applied",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        attachment: { effect: "applied" },
      },
    });
    const state = JSON.parse(
      await readFile(path.join(cwd, "standalone-actions-state.json"), "utf8"),
    ) as {
      documents: Record<string, unknown>;
      links: unknown[];
      renames: unknown[];
      deletions: unknown[];
      decisions: { approved: boolean }[];
      textWrites: { id: string; content: string }[];
      uploads: { issue: string; file: string; base64: string }[];
    };
    expect(state.documents[documentId]).toMatchObject({
      title: "Renamed fixture",
      content: "Alpha\nChanged\nGamma\n",
      issueId: "22222222-2222-4222-8222-222222222222",
    });
    expect(state.links).toEqual([
      { url: "https://linear.app/example/document/fixture-111111111111", title: "Original" },
    ]);
    expect(state.renames).toEqual([{ id: documentId, title: "Renamed fixture" }]);
    expect(state.deletions).toEqual(["allowed", "unknown"]);
    expect(state.decisions.map((entry: { approved: boolean }) => entry.approved)).toEqual([
      false,
      true,
      true,
    ]);
    expect(state.textWrites).toHaveLength(4);
    expect(state.textWrites.filter((entry: { id: string }) => entry.id === unknownId)).toEqual([
      { id: unknownId, content: "Changed unknown\n" },
    ]);
    expect(
      state.uploads.map((entry: { issue: string; file: string; base64: string }) => ({
        issue: entry.issue,
        file: entry.file,
        base64: entry.base64,
      })),
    ).toEqual([
      { issue: "ENG-12", file: "report.bin", base64: bytes.toString("base64") },
      { issue: "ENG-12", file: "uncertain.bin", base64: bytes.toString("base64") },
    ]);
    expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);

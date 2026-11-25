import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
const id = "a8852949-289a-454e-8950-ced239500f26";

test("Codemode can read the milestone created by a successful Write", async () => {
  const ide = await currentIde();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/milestone-receipt-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "milestone-codemode-receipt",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      timeoutMs: 60000,
      extensions: [
        ide.extension,
        "builtin:codemode",
        path.join(root, "tests/fixtures/milestone-links.ts"),
      ],
      tools: ["read", "write", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "script",
              name: "codemode",
              arguments: {
                code: `const receipt = await tools.write({path:"linear://example/milestone/new",content:JSON.stringify({project:"Project & milestones",name:"First milestone"})}); if (!receipt || typeof receipt.source !== "string") throw new Error("Missing creation receipt"); const value = await tools.read({path:receipt.source}); if (!value || typeof value.text !== "string") throw new Error("Cannot read created milestone"); text(value.text);`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Create and read a milestone.");
    await ide.record(result.artifacts.directory);
    expect(getToolExecution(result, "script").isError, getToolResultText(result, "script")).toBe(
      false,
    );
    expect(getToolResultText(result, "script")).toContain("First milestone");
    const operations = (await readFile(path.join(cwd, "milestone-operations.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(operations).toEqual([
      {
        operation: "save_milestone",
        input: { project: "Project & milestones", name: "First milestone" },
      },
      { operation: "get_milestone", input: { project: "Project & milestones", query: id } },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
// Pattern: the extensions example and normalized-save test.
// Contract: ordinary Write returns a usable Read link; missing parent errors explain recovery in Pi.
test("milestone creation returns a readable project link and bare reads explain the missing parent", async () => {
  const ide = await currentIde();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/milestone-links-"));
  try {
    const result = await new PiIntegrationTest({
      testName: "milestone-links",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      tuiSize: { cols: 110, rows: 45 },
      extensions: [
        ide.extension,
        "builtin:codemode",
        path.join(root, "tests/fixtures/milestone-links.ts"),
      ],
      tools: ["read", "write", "codemode"],
      timeoutMs: 60000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "create",
              name: "write",
              arguments: {
                path: "linear://example/milestone/new",
                content: JSON.stringify({
                  project: "Project & milestones",
                  name: "First milestone",
                }),
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "round-trip",
              name: "codemode",
              arguments: {
                code: `const value = await tools.read({path:${JSON.stringify(`linear://example/milestone/${id}?project=Project+%26+milestones`)}}); if (!value || !value.id || typeof value.text !== "string") throw new Error("Invalid Read value"); text(value.text);`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "missing-parent",
              name: "read",
              arguments: { path: `linear://example/milestone/${id}` },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "missing-parent-script",
              name: "codemode",
              arguments: {
                code: `const value = await tools.read({path:"linear://example/milestone/${id}"}); if (value !== null) throw new Error("Expected null for failed Read"); text("continued after missing parent");`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([
          text("Read the created milestone once; the incomplete address needs project."),
        ]),
      ],
    }).run(
      "Create a milestone, follow the returned Read link, then explain why a bare milestone address fails.",
    );
    await ide.record(result.artifacts.directory);
    expect(
      getToolExecution(result, "round-trip").isError,
      getToolResultText(result, "round-trip"),
    ).toBe(false);
    expect(getToolExecution(result, "create").isError).toBe(false);
    expect(getToolResultText(result, "create")).toContain(
      `linear://example/milestone/${id}?project=Project+%26+milestones`,
    );
    expect(getToolResultText(result, "round-trip")).toContain("First milestone");
    expect(getToolExecution(result, "missing-parent").isError).toBe(true);
    const message = getToolResultText(result, "missing-parent");
    expect(message).toContain('Missing required query parameter "project"');
    expect(message).toContain("?project=<value>");
    expect(getToolResultText(result, "missing-parent-script")).toContain(
      'Missing required query parameter "project"',
    );
    expect(result.tuiRenderedOutput.replaceAll(/\s+/gu, " ")).toContain(
      'Missing required query parameter "project"',
    );
    const operations = (await readFile(path.join(cwd, "milestone-operations.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(operations).toEqual([
      {
        operation: "save_milestone",
        input: { project: "Project & milestones", name: "First milestone" },
      },
      { operation: "get_milestone", input: { project: "Project & milestones", query: id } },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);

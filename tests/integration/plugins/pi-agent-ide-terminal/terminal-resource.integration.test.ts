import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterEach, expect, test } from "vitest";

const root = path.resolve();
const workspace = path.join(root, ".agents/tmp/terminal-resource-integration/workspace");
const extensions = [
  path.join(root, "src/extensions/pi-agent-read/index.ts"),
  path.join(root, "src/extensions/pi-agent-text-editor/index.ts"),
  path.join(
    root,
    "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-constant/index.ts",
  ),
  path.join(
    root,
    "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-exact/index.ts",
  ),
  path.join(root, "tests/integration/fixtures/terminal-deterministic.ts"),
];

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

test.runIf(process.platform !== "win32")(
  "uses shared write, insert, and read tools with a live terminal resource",
  async () => {
    await mkdir(workspace, { recursive: true });
    const result = await new PiIntegrationTest({
      testName: "terminal-resource-operations",
      artifactsDir: testArtifactsDir(
        import.meta.filename,
        path.join(root, ".agents/tmp/test-runs"),
      ),
      cwd: workspace,
      extensions,
      tools: ["run", "write", "insert", "replace", "delete", "read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "run-interactive",
              name: "run",
              arguments: {
                command: "IFS= read -r answer; printf 'resource:%s' \"$answer\"",
                background: true,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "replace-terminal",
              name: "replace",
              arguments: { path: "shell:abcdef123456", start: "terminal input", text: "no" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "write-terminal",
              name: "write",
              arguments: { path: "shell:abcdef123456", content: "hello" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "insert-enter",
              name: "insert",
              arguments: { path: "shell:abcdef123456", text: "Enter" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-terminal",
              name: "read",
              arguments: { path: "shell:abcdef123456" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "read-terminal-image",
              name: "read",
              arguments: { path: "shell:abcdef123456", views: ["image"] },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "delete-terminal",
              name: "delete",
              arguments: { path: "shell:abcdef123456" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Terminal resource operations completed.")]),
      ],
    }).run("Interact with the running terminal through shared resource tools");

    expect(getToolExecution(result, "replace-terminal").isError).toBe(true);
    expect(getToolResultText(result, "replace-terminal")).toContain("is unsupported");
    expect(getToolExecution(result, "delete-terminal").isError).toBe(false);
    expect(getToolResultText(result, "delete-terminal")).toContain("Deleted terminal session");
    expect(getToolExecution(result, "write-terminal").isError).toBe(false);
    expect(getToolResultText(result, "write-terminal")).toContain("Sent text");
    expect(getToolExecution(result, "insert-enter").isError).toBe(false);
    expect(getToolResultText(result, "insert-enter")).toContain("Sent keys");
    expect(getToolResultText(result, "read-terminal")).toContain("resource:hello");
    const image = getToolResultMessage(result, "read-terminal-image").content;
    expect(image.some((block) => block.type === "image" && block.mimeType === "image/png")).toBe(
      true,
    );
  },
);

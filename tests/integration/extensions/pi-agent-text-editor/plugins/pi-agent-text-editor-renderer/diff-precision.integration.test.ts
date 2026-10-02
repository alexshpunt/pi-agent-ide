import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "#integration/support/pi-runtime/pi-coding-agent-test.js";

const extension = path.resolve(import.meta.dirname, "register-extension.ts");
const extensions = createExtensionSet();
const defaultEditor = path.resolve(
  process.cwd(),
  "tests/integration/extensions/pi-agent-text-editor/register-extension.ts",
);

test("shows an unavailable warning instead of zero changes when alignment is bounded", async () => {
  await withTempWorkspace(async (directory) => {
    const before = Array.from({ length: 200 }, (_, i) => `legacy legacy legacy ${i}`).join("\n");
    const after = Array.from({ length: 200 }, (_, i) => `modern modern modern ${i}`).join("\n");
    await createFixture(directory, "bounded.txt", before);
    const result = await new PiIntegrationTest({
      testName: "native-diff-budget",
      cwd: directory,
      extensions: extensions.paths.map((item) => (item === defaultEditor ? extension : item)),
      tools: ["replace"],
      rawMode: false,
      environment: { PI_AGENT_IDE_TEST_EXPANDED: "1" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "bounded",
              name: "replace",
              arguments: { path: "bounded.txt", start: "begin", end: "end", text: after },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")], { delayMs: 500 }),
      ],
    }).run("Replace the file and report comparison limits honestly");
    expect(getToolExecution(result, "bounded").isError).toBe(false);
    await expect(readFile(path.join(directory, "bounded.txt"), "utf8")).resolves.toBe(after);
    // The required postflight read scrolls this panel out of the final viewport.
    expect(result.terminalOutput).toContain("Local diff unavailable: alignment limit reached");
    expect(result.terminalOutput).not.toContain("+0 ~0 -0");
  });
});

test("shows exact partial edits and no deletion marker in the real native TUI", async () => {
  await withTempWorkspace(async (directory) => {
    const before = "timeout: 1_000,\nreturn await run();\nuserId\n";
    const after = "timeout: 5_000,\nreturn run();\nuserID\n";
    await createFixture(directory, "precise.txt", before);
    const result = await new PiIntegrationTest({
      testName: "native-diff-precision",
      cwd: directory,
      extensions: extensions.paths.map((item) => (item === defaultEditor ? extension : item)),
      tools: ["replace"],
      rawMode: false,
      environment: { PI_AGENT_IDE_TEST_EXPANDED: "1" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "precise",
              name: "replace",
              arguments: {
                path: "precise.txt",
                start: "begin",
                end: "end",
                text: after,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")], { delayMs: 500 }),
      ],
    }).run("Replace the three lines and show only their exact changes");
    expect(getToolExecution(result, "precise").isError).toBe(false);
    expect(getToolResultText(result, "precise")).toContain("precise.txt");
    await expect(readFile(path.join(directory, "precise.txt"), "utf8")).resolves.toBe(after);
    const screen = result.tuiRenderedOutput;
    expect(screen).toContain("timeout: 5_000,");
    expect(screen).toContain("return run();");
    expect(screen).not.toContain("⌫");
    expect(screen).toContain("userID");
    expect(screen).toContain("+0 ~3 -0");
    const mutationStart = screen.indexOf("replace precise.txt");
    const panelStart = screen.indexOf("╭", mutationStart);
    const panel = screen.slice(panelStart, screen.indexOf("╯", panelStart) + 1);
    expect(panel).not.toContain("await");
    expect(panel).not.toContain("1_000");
    expect(panel).not.toMatch(/\d+\s[+-] /u);
  });
});

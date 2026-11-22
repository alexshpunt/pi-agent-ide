import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { capabilityExcludedTools, capabilitySettings } from "#capabilities/run-policy.ts";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "./support/pi-runtime/native-pi-coding-agent-test.ts";

function call(id: string, name: string, args: Record<string, unknown>) {
  return assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
}

for (const mode of ["direct", "codemode"]) {
  test(`capability runner exposes the native ${mode} loadout`, async () => {
    const root = path.resolve(".tmp/capability-loadout");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    const agent = path.join(cwd, "agent");
    const settings = capabilitySettings(mode);
    try {
      await mkdir(agent);
      await writeFile(path.join(agent, "settings.json"), JSON.stringify(settings));
      await writeFile(path.join(cwd, "task.txt"), "BEFORE\n");
      const result = await new PiIntegrationTest({
        testName: `capability-loadout-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          "builtin:tool-search",
        ],
        piCommand: path.resolve("tests/integration/support/pi-runtime/selected-host.sh"),
        environment: {
          PI_CODING_AGENT_DIR: agent,
          PI_AGENT_IDE_TEST_SELECTION: "capability",
          PI_AGENT_IDE_TEST_EXCLUDED_TOOLS: capabilityExcludedTools(mode).join(","),
          PI_AGENT_IDE_TEST_HOST_COMMAND: process.env.PI_COMMAND ?? "pi",
        },
        conversation: [
          ...(mode === "codemode"
            ? [
                call("inspect", "codemode", {
                  code: 'text(await tools.read({path:"task.txt"})); text(await tools.diff({before:"task.txt",after:"task.txt"})); text(await tools.bash({command:"printf LOADOUT-MARKER"}));',
                }),
                call("discover", "tool_search", { query: "diff", limit: 1 }),
                call("change", "codemode", {
                  code: 'text(await searchTools("diff")); text(await describeTool("replace")); text(await tools.replace({path:"task.txt",at:"BEFORE",text:"AFTER"}));',
                }),
              ]
            : [
                call("inspect", "read", { path: "task.txt" }),
                call("change", "replace", { path: "task.txt", at: "BEFORE", text: "AFTER" }),
                call("discover", "tool_search", { query: "diff", limit: 1 }),
                call("compare", "diff", { before: "task.txt", after: "task.txt" }),
              ]),
          assistantMessage([text("Done")]),
        ],
      }).run("Read task.txt, compare it with itself, then replace BEFORE with AFTER.");
      expect(getToolExecution(result, "inspect").isError).toBe(false);
      expect(getToolExecution(result, "change").isError).toBe(false);
      expect(getToolResultText(result, "inspect")).toContain("BEFORE");
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("AFTER\n");
      const declarations = result.providerRequests.map((request) =>
        getCurrentTools(request.messages as Message[])
          .map((tool) => tool.name)
          .sort(),
      );
      expect(declarations.length).toBeGreaterThan(1);
      if (mode === "codemode") {
        expect(getToolResultText(result, "inspect")).toContain("LOADOUT-MARKER");
        expect(getToolExecution(result, "discover").isError).toBe(true);
        for (const names of declarations) expect(names).toEqual(["codemode"]);
      } else {
        expect(declarations[0]).toEqual(
          [...settings.defaultTools, "file_search", "outline"]
            .filter((name) => name !== "codemode")
            .sort(),
        );
        expect(declarations.at(-1)).toContain("diff");
        expect(getToolExecution(result, "compare").isError).toBe(false);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

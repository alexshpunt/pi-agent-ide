import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionResult,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";

const call = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });

test.each(["direct", "native"] as const)(
  "edit is unreachable while guarded editing still works (%s)",
  async (profile) => {
    const native = profile === "native";
    const root = path.resolve(".tmp/hidden-edit");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "case-"));
    try {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ noAnimations: true, noPostProcessing: true }),
      );
      await writeFile(path.join(cwd, "subject.txt"), "alpha\nbeta\n");
      const result = await new PiIntegrationTest({
        testName: `hidden-edit-${profile}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        isolateUserResources: true,
        environment: { PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "0" },
        cwd,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve("tests/integration/fixtures/edit-availability-probe.ts"),
          ...(native ? ["builtin:codemode", "builtin:tool-search"] : []),
        ],
        // Explicit selection must not turn the withdrawn placeholder back on.
        tools: [
          "edit",
          "edit_availability_probe",
          "read",
          "insert",
          ...(native ? ["codemode", "tool_search"] : []),
        ],
        conversation: [
          call("availability", "edit_availability_probe", {}),
          ...(native
            ? [
                call("discover", "tool_search", { query: "edit", limit: 20 }),
                call("script", "codemode", {
                  code: 'let description; try { description = await describeTool("edit"); } catch {} text({editType: "edit" in tools ? "available" : "undefined", matches: await searchTools("edit", {limit: 20}), description});',
                }),
              ]
            : []),
          call("direct-edit", "edit", {}),
          call("read", "read", { path: "subject.txt", views: ["anchors"] }),
          call("insert", "insert", { path: "subject.txt", anchor: "1#BE76", text: "recovered" }),
          assistantMessage([text("Done")]),
        ],
      }).run("Check that edit is withdrawn, then use the guarded editor.");
      const availability = JSON.parse(getToolResultText(result, "availability")) as {
        edit: { exposure: string };
        active: string[];
        callable: string[];
        nested: { isError: boolean; result: { content: { type: string; text?: string }[] } };
      };
      expect(availability.edit.exposure).toBe("hidden");
      expect(availability.active).not.toContain("edit");
      expect(availability.callable).not.toContain("edit");
      expect(availability.nested.isError).toBe(true);
      expect(availability.nested.result.content).toContainEqual({
        type: "text",
        text: "Tool edit not found",
      });
      expect(getToolExecution(result, "direct-edit").isError).toBe(true);
      expect(getToolResultText(result, "direct-edit")).toBe("Tool edit not found");
      const declarations = (await readFile(path.join(cwd, "provider-tools.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(declarations.length).toBeGreaterThan(0);
      for (const tools of declarations) expect(tools).not.toContain("edit");
      if (native) {
        expect(getToolExecution(result, "discover").isError).toBe(false);
        const discovery = getToolExecutionDetails(getToolExecution(result, "discover")) as {
          loaded: string[];
        };
        expect(discovery.loaded).not.toContain("edit");
        expect(getToolExecution(result, "script").isError).toBe(false);
        const execution = getToolExecutionResult(result, "script") as {
          content: { type: string; text?: string }[];
        };
        const output = execution.content.find(
          (part) => part.type === "text" && part.text?.startsWith("{"),
        );
        if (output?.text === undefined) throw new Error("Missing script JSON output");
        const script = JSON.parse(output.text) as {
          editType: string;
          matches: { name: string }[];
          description?: unknown;
        };
        expect(script.editType).toBe("undefined");
        expect(script.matches.some((tool: { name: string }) => tool.name === "edit")).toBe(false);
        expect(script.description).toBeUndefined();
      }
      expect(getToolExecution(result, "read").isError).toBe(false);
      expect(getToolExecution(result, "insert").isError).toBe(false);
      expect(await readFile(path.join(cwd, "subject.txt"), "utf8")).toBe(
        "alpha\nrecovered\nbeta\n",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  60_000,
);

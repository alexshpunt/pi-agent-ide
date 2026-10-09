import { mkdir, readFile, writeFile } from "node:fs/promises";
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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";
import { capabilityCases } from "#capabilities/cases.ts";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

async function prepare(cwd: string): Promise<string> {
  const directory = path.join(cwd, ".tmp/move-effects");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "owned.txt"), "LPT-642 disposable fixtures\n");
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({
      disabled: ["ide.lsp", "ide.lint"],
      noAnimations: true,
      noPostProcessing: true,
    }),
  );
  return directory;
}

const extensions = [
  path.resolve("src/pi-agent-ide.ts"),
  path.resolve("src/extensions/pi-agent-text-editor/test/fixtures/move-effects-probe.ts"),
];

function move(id: string, arguments_: Record<string, unknown>) {
  return assistantMessage(
    [
      toolCall({
        id,
        name: "move",
        arguments: arguments_,
        chunks: { kind: "fixed", size: 4096 },
        delayMs: 0,
      }),
    ],
    { stopReason: "toolUse" },
  );
}

test("whole-file Move preserves unknown effects before and after fixture bytes change", async () => {
  await withTempWorkspace(async (cwd) => {
    const directory = await prepare(cwd);
    for (const name of ["unknown-before", "unknown-after", "applied"]) {
      await writeFile(path.join(directory, `${name}.txt`), "source bytes\n");
      await writeFile(path.join(directory, `${name}-target.txt`), "old target\n");
    }
    const run = await new PiIntegrationTest({
      testName: "move-whole-file-effects",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      isolateUserResources: true,
      extensions,
      tools: ["move", "read"],
      conversation: [
        ...["unknown-before", "unknown-after", "applied", "missing"].flatMap((name) => [
          move(name, {
            path: `.tmp/move-effects/${name}.txt`,
            target: `.tmp/move-effects/${name}-target.txt`,
          }),
          ...(name === "unknown-after"
            ? [
                assistantMessage(
                  [
                    toolCall({
                      id: "inspect-unknown-destination",
                      name: "read",
                      arguments: { path: ".tmp/move-effects/unknown-after-target.txt" },
                    }),
                  ],
                  { stopReason: "toolUse" },
                ),
              ]
            : []),
        ]),
        assistantMessage([text("Move effect checks finished.")]),
      ],
    }).run("Move only the disposable fixture files and preserve effect evidence");
    for (const id of ["unknown-before", "unknown-after"]) {
      expect(getToolExecution(run, id).isError).toBe(true);
      expect(getToolExecutionDetails(getToolExecution(run, id))).toMatchObject({
        metadata: { semanticAction: { ok: false, effect: "unknown" } },
      });
      const output = getToolResultText(run, id).split("\n\n---\n\n# Guide:")[0] ?? "";
      expect(output).toContain("move: unknown");
      expect(output).not.toContain("not-applied");
    }
    expect(getToolResultText(run, "inspect-unknown-destination")).toContain("source bytes");
    expect(getToolExecution(run, "applied").isError).toBe(false);
    expect(getToolResultText(run, "applied")).toContain("move: applied");
    expect(getToolExecution(run, "missing").isError).toBe(true);
    expect(getToolResultText(run, "missing")).toContain("move: not-applied");
    expect(run.tuiRenderedOutput.match(/Effects unknown/g)).toHaveLength(2);
    expect(run.tuiRenderedOutput).toContain("read source and destination before retrying");
    expect(run.tuiRenderedOutput.match(/Not applied/g)).toHaveLength(1);
    expect(run.tuiRenderedOutput).toContain("✓ Applied");
    expect(await readFile(path.join(directory, "unknown-before.txt"), "utf8")).toBe(
      "source bytes\n",
    );
    expect(await readFile(path.join(directory, "unknown-before-target.txt"), "utf8")).toBe(
      "old target\n",
    );
    for (const name of ["unknown-after", "applied"]) {
      await expect(readFile(path.join(directory, `${name}.txt`))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(path.join(directory, `${name}-target.txt`), "utf8")).toBe(
        "source bytes\n",
      );
    }
    await expect(readFile(path.join(directory, "missing-target.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

test.each(["direct", "codemode"])(
  "the unknown-effect capability runs through %s without retrying",
  async (mode) => {
    await withTempWorkspace(async (cwd) => {
      await prepare(cwd);
      const task = capabilityCases.find((candidate) => candidate.id === "move-unknown-effects");
      if (!task?.files) throw new Error("Missing Move effect capability case");
      for (const [file, contents] of Object.entries(task.files))
        await writeFile(path.join(cwd, file), contents);
      const run = await new PiIntegrationTest({
        testName: `move-capability-unknown-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        cwd,
        isolateUserResources: true,
        extensions: [...extensions, "builtin:codemode"],
        tools: ["move", "read", "codemode"],
        conversation: [
          ...(mode === "direct"
            ? task.steps.map((step, index) =>
                assistantMessage(
                  [toolCall({ id: `route-${index}`, name: step.tool, arguments: step.args ?? {} })],
                  { stopReason: "toolUse" },
                ),
              )
            : [
                assistantMessage(
                  [
                    toolCall({
                      id: "inspect-failed-move",
                      name: "codemode",
                      arguments: {
                        code: 'try { await tools.move({path:".tmp/move-effects/unknown-after.txt",target:".tmp/move-effects/unknown-after-target.txt"}); } catch (error) { text(String(error)); } text(await tools.read({path:".tmp/move-effects/unknown-after-target.txt"}));',
                      },
                    }),
                  ],
                  { stopReason: "toolUse" },
                ),
              ]),
          assistantMessage([text("Move effects remain unknown; the destination was inspected.")]),
        ],
      }).run(task.prompt ?? "Inspect the failed fixture Move");
      if (mode === "codemode")
        expect(getToolExecution(run, "inspect-failed-move").isError).toBe(false);
      const events = run.traceEvents.flatMap((entry) =>
        "event" in entry && entry.event && typeof entry.event === "object"
          ? [entry.event as RunEvent]
          : [],
      );
      expect(validateRoute(task, events, mode)).toEqual({ passed: true, reasons: [] });
      expect(
        events.filter(
          (event) => event.type === "tool_execution_start" && event.toolName === "move",
        ),
      ).toHaveLength(1);
      expect(run.tuiRenderedOutput).toContain("Effects unknown");
      expect(run.tuiRenderedOutput).not.toContain("Not applied");
      expect(
        await readFile(path.join(cwd, ".tmp/move-effects/unknown-after-target.txt"), "utf8"),
      ).toBe(task.expected?.[".tmp/move-effects/unknown-after-target.txt"]);
      await expect(
        readFile(path.join(cwd, ".tmp/move-effects/unknown-after.txt")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
test("text Move failure keeps uncertainty after receipt creation fails", async () => {
  await withTempWorkspace(async (cwd) => {
    const directory = await prepare(cwd);
    await writeFile(path.join(directory, "text-source.txt"), "before\nMOVE-ME\nafter\n");
    await writeFile(path.join(directory, "text-target.txt"), "head\ntail\n");
    const run = await new PiIntegrationTest({
      testName: "move-text-effects",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      isolateUserResources: true,
      extensions,
      tools: ["move"],
      conversation: [
        move("text-move", {
          path: ".tmp/move-effects/text-source.txt",
          start: "MOVE-ME",
          target: ".tmp/move-effects/text-target.txt",
          targetStart: "head",
        }),
        assistantMessage([text("The failed Move needs inspection before retrying.")]),
      ],
    }).run("Move the fixture text and preserve uncertain failure evidence");
    expect(getToolExecution(run, "text-move").isError).toBe(true);
    expect(getToolExecutionDetails(getToolExecution(run, "text-move"))).toMatchObject({
      effect: "unknown",
    });
    const output = getToolResultText(run, "text-move");
    expect(output).toContain("effects are unknown");
    expect(output).not.toContain("No file was changed");
    expect(run.tuiRenderedOutput).toContain("Effects unknown");
    expect(run.tuiRenderedOutput).not.toContain("Not changed");
    expect(await readFile(path.join(directory, "text-source.txt"), "utf8")).toBe("before\nafter\n");
    expect(await readFile(path.join(directory, "text-target.txt"), "utf8")).toBe(
      "head\nMOVE-ME\ntail\n",
    );
  });
});

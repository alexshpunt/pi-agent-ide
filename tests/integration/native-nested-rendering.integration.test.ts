import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { PiRun } from "pi-coding-agent-test/base";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("direct IDE mutations keep the same custom renderer in an isolated runtime", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\n");
    const run = await new PiIntegrationTest({
      testName: "direct-isolated-mutation",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "direct",
              name: "replace",
              arguments: { path: "note.txt", start: "alpha", text: "ALPHA" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Replace a line directly");
    expect(getToolExecution(run, "direct").isError).toBe(false);
    expect(run.tuiRenderedOutput).toContain("+0 ~1 -0");
  });
});

// The script deliberately prints nothing: user panels must not depend on text(result).
test("nested IDE results keep their custom panels below Codemode without script output", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"], noAnimations: true }),
    );
    const run = await new PiIntegrationTest({
      testName: "native-nested-custom-panels",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "read", "search", "replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "parent",
              name: "codemode",
              arguments: {
                code: 'await tools.read({path:"note.txt"}); await tools.search({path:"note.txt",query:"beta"}); await tools.replace({path:"note.txt",start:"beta",text:"BETA"});',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Run nested IDE tools without printing their results");
    expect(getToolExecution(run, "parent").isError).toBe(false);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\nBETA\n");
    expect(run.tuiRenderedOutput).toContain("Nested IDE results");
    const panels = run.tuiRenderedOutput.split("Nested IDE results")[1] ?? "";
    expect(panels).toContain("BETA");
    expect(panels).toContain("+0 ~1 -0");
    expect(panels).not.toContain("not yet applied");
    const saved = await PiRun.open(run.artifacts.run);
    expect(saved.session).toContain("ide-nested-results");
    expect(saved.session).toContain("nestedCalls");
    const panelEntry = saved.session
      ?.split("\n")
      .find((line) => line.includes('"customType":"ide-nested-results"'));
    expect(panelEntry).not.toContain('"beforeContentMap"');
    expect(panelEntry).not.toContain('"afterDocument"');
    expect(saved.session).not.toContain('"editorBatchRender"');
    const session = path.join(cwd, "saved.jsonl");
    await writeFile(session, saved.session ?? "");
    const restored = await new PiIntegrationTest({
      testName: "native-nested-panels-restored",
      tuiSize: { cols: 60, rows: 50 },
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/fixtures/restore-tool-history.ts"),
      ],
      tools: ["read"],
      environment: {
        IDE_RESTORE_SESSION: session,
        IDE_HISTORY_EXPANDED: "1",
        IDE_RESTORE_TREE_RESULT: "1",
        IDE_HISTORY_THEME: "light",
      },
      conversation: [assistantMessage([text("Restored")])],
    }).run("/restore-tool-history");
    const restoredPanels = restored.tuiRenderedOutput.split("Nested IDE results")[1] ?? "";
    expect(restoredPanels).toContain("+0 ~1 -0");
    expect(restoredPanels).toContain("BETA");
    expect(restoredPanels).not.toContain("not yet applied");
    await promisify(execFile)(process.env.PI_COMMAND ?? "pi", [
      "--export",
      session,
      path.join(cwd, "history.html"),
    ]);
    const html = await readFile(path.join(cwd, "history.html"), "utf8");
    const encoded = html.match(
      /<script id="session-data" type="application\/json">([^<]+)<\/script>/,
    )?.[1];
    expect(encoded).toBeDefined();
    const exportedData = Buffer.from(encoded ?? "", "base64").toString("utf8");
    expect(exportedData).toContain("nestedCalls");
    expect(exportedData).toContain("BETA");
    expect(html).toContain("setHiddenMessagesVisible");
    await writeFile(path.join(run.artifacts.directory, "export.html"), html);
  });
});

test("ordinary parent failure preserves committed batch effects without repeating its diff", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\nbeta\n");
    const run = await new PiIntegrationTest({
      testName: "nested-parent-error",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "parent",
              name: "codemode",
              arguments: {
                code: 'await tools.replace({path:"note.txt",start:"alpha",text:"ALPHA"}); await tools.replace({path:"note.txt",start:"beta",text:"BETA"}); throw new Error("parent stopped");',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Stopped")]),
      ],
    }).run("Edit both lines then fail");
    expect(getToolExecution(run, "parent").isError).toBe(true);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("ALPHA\nBETA\n");
    const panels = run.tuiRenderedOutput.split("Nested IDE results")[1] ?? "";
    expect(panels).toContain("Applied in the same editor batch");
    expect(panels.match(/\+0 ~2 -0/g)).toHaveLength(1);
    expect(panels).not.toContain("not yet applied");
  });
});

test("nested display retention is bounded and labels omitted results honestly", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(
      path.join(cwd, "large.txt"),
      "large retained line ".repeat(60) +
        "\n".repeat(2) +
        ("body line ".repeat(50) + "\n").repeat(140),
    );
    const run = await new PiIntegrationTest({
      testName: "nested-bounded-panels",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "parent",
              name: "codemode",
              arguments: { code: 'for (let i=0;i<16;i++) await tools.read({path:"large.txt"});' },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read repeatedly without printing");
    expect(getToolExecution(run, "parent").isError).toBe(false);
    const saved = await PiRun.open(run.artifacts.run);
    const panelLine = saved.session
      ?.split("\n")
      .find((line) => line.includes('"customType":"ide-nested-results"'));
    expect(panelLine).toBeDefined();
    expect(Buffer.byteLength(panelLine ?? "")).toBeLessThan(513 * 1024);
    expect(panelLine).toContain('"complete":false');
    expect(run.tuiRenderedOutput).toContain("Incomplete nested IDE presentation");
  });
});

test("nested terminal and debugger calls retain their custom panels and a child error", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "example.py"), "value = 42\nprint(value)\n");
    const run = await new PiIntegrationTest({
      testName: "nested-terminal-debugger-error",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "bash", "read", "debug"],
      environment: { SHELL: "/bin/bash" },
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "parent",
              name: "codemode",
              arguments: {
                code: 'const background = await tools.bash({command:"sleep 0.2; printf nested-background",background:true}); await tools.bash({command:"sleep 0.3; printf nested-terminal"}); await tools.read({path:background.source}); await tools.debug({adapter:"debugpy",program:"example.py"}); await tools.read({path:"missing.txt"});',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Run terminal and debugger work followed by a failed Read");
    expect(getToolExecution(run, "parent").isError).toBe(false);
    const panels = run.tuiRenderedOutput.split("Nested IDE results")[1] ?? "";
    expect(panels).toContain("nested-terminal");
    expect(panels).toContain("nested-background");
    expect(panels).toContain("debugpy");
    expect(panels).toContain("configure debugger");
    expect(panels).toContain("missing.txt");
    const saved = await PiRun.open(run.artifacts.run);
    const panelLine = saved.session
      ?.split("\n")
      .find((line) => line.includes('"customType":"ide-nested-results"'));
    expect(panelLine).toContain('"isError":true');
    expect(panelLine).toContain('"name":"debug"');
    expect(panelLine).toContain('"status":"configured"');
    expect(panelLine).toContain("fullOutputPath");
  });
});
test("a deadline renders accepted edits as not applied rather than successful", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "note.txt"), "alpha\n");
    const run = await new PiIntegrationTest({
      testName: "nested-deadline-panels",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["codemode", "replace"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "parent",
              name: "codemode",
              arguments: {
                code: '// @options: {"timeout_ms":2000}\nawait tools.replace({path:"note.txt",start:"alpha",text:"UNWRITTEN"}); while (true) {}',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Stopped")]),
      ],
    }).run("Reach a deadline before writing accepted edits");
    expect(getToolExecution(run, "parent").isError).toBe(true);
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("alpha\n");
    const panels = run.tuiRenderedOutput.split("Nested IDE results")[1] ?? "";
    expect(panels).toContain("Not changed");
    expect(panels).not.toContain("not yet applied");
    expect(panels).not.toContain("+0 ~1 -0");
  });
});

test("native child usage is aggregated once and display data never copies usage", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "billable.txt"), "known\n");
    await writeFile(path.join(cwd, "unknown.txt"), "unknown\n");
    const run = await new PiIntegrationTest({
      testName: "nested-native-usage",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/nested-usage-probe.ts"),
      ],
      tools: ["codemode", "read"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "parent",
              name: "codemode",
              arguments: {
                code: 'await tools.read({path:"billable.txt"}); await tools.read({path:"unknown.txt"}); await tools.read({path:"billable.txt"}); text(await models.classify({provider:"nested-fixture",id:"retained-classifier"}, {state:{},questions:{passed:{type:"bool",instructions:"Always true",criteria:{true:"yes",false:"no"}}}}));',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read known and unknown billing");
    const parent = getToolResultMessage(run, "parent");
    expect(parent.usage).toMatchObject({
      input: 24,
      output: 5,
      totalTokens: 29,
      cost: { total: 0.625 },
    });
    expect(parent.nestedCalls?.calls).toHaveLength(3);
    const output = parent.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(output).toContain('"provider":"nested-fixture"');
    expect(output).toContain('"model":"retained-classifier"');
    const saved = await PiRun.open(run.artifacts.run);
    const panelLine = saved.session
      ?.split("\n")
      .find((line) => line.includes('"customType":"ide-nested-results"'));
    expect(panelLine).not.toContain('"usage"');
    expect(panelLine).not.toContain('"structuredContent"');
    expect(JSON.stringify(run.providerRequests.at(-1)?.messages)).not.toContain(
      "ide-nested-results",
    );
  });
});

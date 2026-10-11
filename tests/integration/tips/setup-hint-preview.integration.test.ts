import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { TipStateStore } from "#src/tips/persistence.js";
import { createSetupHintProvider } from "#src/tips/setup-hint.js";

test("manual preview shows a consumed setup hint without changing its claim or model context", async () => {
  await withTempWorkspace(async (cwd) => {
    const agent = path.join(cwd, "agent");
    const stateFile = path.join(agent, "pi-agent-ide/tips.json");
    const state = new TipStateStore(stateFile);
    const identity = JSON.stringify(["agent-setup", "agent-setup-v1"]);
    await state.claimIfUnseen(undefined, identity, "agent-setup-v1");
    const before = await readFile(stateFile, "utf8");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        disabled: ["ide.doctor"],
      }),
    );
    const output = path.join(cwd, "preview.json");
    const run = await new PiIntegrationTest({
      testName: "setup-hint-manual-preview",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("tests/integration/fixtures/setup-hint-preview-probe.ts")],
      skills: [path.resolve("skills/configure-agent-ide")],
      tools: [],
      transport: "tui",
      tuiSize: { cols: 60, rows: 24 },
      rawMode: false,
      isolateUserResources: false,
      environment: { PI_CODING_AGENT_DIR: agent, IDE_SETUP_PREVIEW_RESULT: output },
      conversation: [assistantMessage([text("Done")])],
    }).run("/inspect-setup-hint");
    expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
      registered: true,
      stateUnchanged: true,
      added: 1,
      requests: 0,
    });
    expect(await readFile(stateFile, "utf8")).toBe(before);
    const tip = await createSetupHintProvider(() => true).getTip({
      cwd,
      mode: "tui",
      hasUI: true,
      reason: "startup",
    });
    if (!tip) throw new Error("Missing setup hint");
    expect(run.tuiRenderedOutput).toContain(tip.title);
    expect(JSON.stringify(run.providerRequests)).not.toContain(tip.body);
  });
});

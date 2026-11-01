import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { assistantMessage, PiIntegrationTest, testArtifactsDir, text } from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("live settings apply without reload and pending module changes clear when reverted", async () => {
  await withTempWorkspace(async (cwd) => {
    const agent = path.join(cwd, "agent");
    await mkdir(agent);
    const output = path.join(cwd, "settings-probe.json");
    const run = await new PiIntegrationTest({
      testName: "live-settings-panel",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      tuiSize: { cols: 100, rows: 32 },
      extensions: [path.resolve("tests/integration/fixtures/live-settings-probe.ts")],
      tools: [],
      timeoutMs: 30_000,
      environment: {
        PI_CODING_AGENT_DIR: agent,
        IDE_LIVE_SETTINGS_SOURCE: path.resolve("src/pi-agent-ide.ts"),
        IDE_LIVE_SETTINGS_PROBE: output,
      },
      conversation: [assistantMessage([text("Ready")])],
    }).run("/agent-ide-settings");
    const result = JSON.parse(await readFile(output, "utf8")) as {
      events: { preferences: Record<string, string> }[];
      statuses: (string | null)[];
      confirms: boolean[];
      frames: string[][];
      snapshots: { disabled: string[]; preferences?: Record<string, string> }[];
    };
    expect(result.snapshots).toHaveLength(6);
    expect(result.snapshots[0]?.preferences?.["ui.codemode"]).toBe("on");
    expect(result.snapshots[1]?.disabled).toContain("ide.core");
    expect(result.snapshots[2]?.disabled).not.toContain("ide.core");
    expect(result.snapshots[3]?.disabled).toContain("ide.core");
    expect(result.snapshots[3]?.preferences?.["ui.codemode"]).toBe("off");
    expect(result.snapshots[4]?.disabled).not.toContain("ide.core");
    expect(result.snapshots[5]?.preferences?.["search.semantic.engine"]).toBe("vera");
    expect(result.events[0]?.preferences["ui.codemode"]).toBe("on");
    expect(result.statuses[0]).toBeNull();
    expect(result.statuses[1]).toBeTruthy();
    expect(result.statuses[2]).toBeNull();
    expect(result.statuses[3]).toBeTruthy();
    expect(result.statuses[4]).toBeNull();
    expect(result.statuses[5]).toBeNull();
    expect(result.events[3]?.preferences["ui.codemode"]).toBe("off");
    expect(result.confirms).toEqual([false, false]);
    expect(result.frames.length).toBeGreaterThan(3);
    expect(run.providerRequests).toHaveLength(1);
  });
});

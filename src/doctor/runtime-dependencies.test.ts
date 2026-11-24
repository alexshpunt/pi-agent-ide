import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { textSearchDoctorPlugin } from "#src/extensions/pi-agent-search/plugins/pi-agent-search-text/src/doctor-plugin.ts";
import { astDoctorPlugin } from "#src/plugins/pi-agent-ide-ast/src/doctor-plugin.ts";

import { webDoctorPlugin } from "#src/extensions/pi-agent-read/extensions/pi-agent-web/src/doctor-plugin.ts";
import { changesDoctorPlugin } from "#src/plugins/pi-agent-ide-changes/src/doctor-plugin.ts";
import { DoctorCore, runContributedChecks, runContributedSetupChecks } from "./core.ts";
import { buildDoctorAgentPrompt, doctorNeedsWork, runDoctor } from "./run.ts";

test("reports unavailable runtime executables with their feature severity", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-agent-doctor-runtime-"));

  try {
    const core = new DoctorCore();
    await core.registerPlugin(textSearchDoctorPlugin);
    await core.registerPlugin(astDoctorPlugin);
    await core.registerPlugin(changesDoctorPlugin);

    await core.registerPlugin(webDoctorPlugin);
    const context = {
      cwd,
      files: [path.join(cwd, "main.cpp")],
      detectedLanguageIds: new Set(["cpp"]),
      detectedLanguages: new Map([["cpp", [path.join(cwd, "main.cpp")]]]),
      env: {
        PATH: "",
        PI_CODING_AGENT_DIR: cwd,
        PI_AGENT_IDE_BROWSER_PATH: path.join(cwd, "missing"),
      },
    };
    const sections = await runContributedChecks(core.snapshot(), context);
    const setup = await runContributedSetupChecks(core.snapshot(), context);
    const findings = new Map(
      sections.flatMap((section) => section.findings.map((finding) => [section.title, finding])),
    );

    expect(findings.get("Local search")).toMatchObject({ status: "fail" });
    // ast-grep ships with the package, so an empty PATH does not remove it.
    expect(findings.get("Structural search")).toMatchObject({ status: "pass" });
    expect(findings.get("Git changes")).toMatchObject({ status: "warn" });

    expect(findings.get("Browser web reads")).toMatchObject({ status: "warn" });

    expect(setup.actions.map((action) => action.id)).toEqual(["ripgrep-unavailable"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each(["missing", "non-browser"])(
  "Doctor offers browser setup for a %s executable",
  async (kind) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-agent-doctor-browser-"));
    try {
      const core = new DoctorCore();
      await core.registerPlugin(webDoctorPlugin);
      const executable = kind === "missing" ? path.join(cwd, "missing") : process.execPath;
      const run = await runDoctor(core.snapshot(), cwd, { PI_AGENT_IDE_BROWSER_PATH: executable });
      expect(
        run.sections.find((section) => section.pluginId === "web-browser")?.findings,
      ).toMatchObject([{ status: "warn" }]);
      expect(run.actions).toMatchObject([{ id: "browser-unavailable", pluginId: "web-browser" }]);
      expect(doctorNeedsWork(run)).toBe(true);
      const instructions = run.actions[0]?.agentInstructions;
      expect(instructions).toBeTruthy();
      expect(buildDoctorAgentPrompt(run)).toContain(instructions);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

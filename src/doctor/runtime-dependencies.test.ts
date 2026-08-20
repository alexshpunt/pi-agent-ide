import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { textSearchDoctorPlugin } from "#src/extensions/pi-agent-search/plugins/pi-agent-search-text/src/doctor-plugin.js";
import { astDoctorPlugin } from "#src/plugins/pi-agent-ide-ast/src/doctor-plugin.js";
import { changesDoctorPlugin } from "#src/plugins/pi-agent-ide-changes/src/doctor-plugin.js";
import { DoctorCore, runContributedChecks } from "./core.js";

test("reports unavailable runtime executables with their feature severity", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-agent-doctor-runtime-"));

  try {
    const core = new DoctorCore();
    await core.registerPlugin(textSearchDoctorPlugin);
    await core.registerPlugin(astDoctorPlugin);
    await core.registerPlugin(changesDoctorPlugin);
    const sections = await runContributedChecks(core.snapshot(), {
      cwd,
      files: [path.join(cwd, "main.cpp")],
      detectedLanguageIds: new Set(["cpp"]),
      env: { PATH: "", PI_CODING_AGENT_DIR: cwd },
    });
    const findings = new Map(
      sections.flatMap((section) => section.findings.map((finding) => [section.title, finding])),
    );

    expect(findings.get("Local search")).toMatchObject({ status: "fail" });
    expect(findings.get("Structural search")).toMatchObject({ status: "fail" });
    expect(findings.get("Git changes")).toMatchObject({ status: "warn" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

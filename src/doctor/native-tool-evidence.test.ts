import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { DoctorCore } from "./core.js";
import { inspectDoctorSetup } from "./run.js";
import { lintDoctorPlugin } from "#src/plugins/pi-agent-ide-lint/src/doctor-plugin.js";

test("a package manifest alone does not select JSONLint", async () => {
  const parent = path.resolve(".agents/tmp/doctor-native-evidence");
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(path.join(parent, "project-"));
  try {
    await writeFile(path.join(cwd, "package.json"), '{"name":"native-project","private":true}\n');
    const core = new DoctorCore();
    await core.registerPlugin(lintDoctorPlugin);
    const snapshot = {
      ...core.snapshot(),
      languages: [
        { pluginId: "languages", value: { id: "json", name: "JSON", extensions: [".json"] } },
      ],
    };
    const inspect = () => inspectDoctorSetup(snapshot, cwd, { PATH: "" });
    expect((await inspect()).actions.map((action) => action.id)).not.toContain(
      "linter-jsonlint-unavailable",
    );
    await writeFile(
      path.join(cwd, "package.json"),
      '{"name":"native-project","devDependencies":{"@prantlf/jsonlint":"17.0.1"}}\n',
    );
    expect((await inspect()).actions.map((action) => action.id)).toContain(
      "linter-jsonlint-unavailable",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

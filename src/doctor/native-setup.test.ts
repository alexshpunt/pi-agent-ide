import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { DoctorCore } from "./core.js";
import { inspectDoctorSetup } from "./run.js";
import { formatterDoctorPlugin } from "#src/plugins/pi-agent-ide-formatter/src/doctor-plugin.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

test("Doctor identifies a native formatter whose executable is missing", async () => {
  const root = path.resolve(".agents/tmp/doctor-native-tests");
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "project-"));
  directories.push(cwd);
  await writeFile(path.join(cwd, "main.cpp"), "int main() { return 0; }\n");
  await writeFile(path.join(cwd, ".clang-format"), "BasedOnStyle: LLVM\n");
  const core = new DoctorCore();
  await core.registerPlugin(formatterDoctorPlugin);
  const snapshot = core.snapshot();
  const result = await inspectDoctorSetup(
    {
      ...snapshot,
      languages: [
        { pluginId: "languages", value: { id: "cpp", name: "C++", extensions: [".cpp"] } },
      ],
    },
    cwd,
    { PATH: "", PI_CODING_AGENT_DIR: path.join(cwd, "agent") },
  );
  expect(result.detectedLanguages.has("cpp")).toBe(true);
  expect(result.selections).toEqual([]);
  expect(result.actions).toMatchObject([
    { id: "formatter-clang-format-unavailable", pluginId: "formatter" },
  ]);
});

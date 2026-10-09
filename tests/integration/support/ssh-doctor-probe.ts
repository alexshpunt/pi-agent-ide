import { requiredValue } from "pi-agent-invariant";
import { createSshDoctorWorkspace } from "#src/backend/doctor-workspace.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { writeSuggestedConfigs } from "#src/doctor/config-writer.js";
import { DoctorCore } from "#src/doctor/core.js";
import { runDoctor } from "#src/doctor/run.js";
import type { RecipeCandidate } from "#src/doctor/discovery.js";
import { webDoctorPlugin } from "#src/extensions/pi-agent-read/extensions/pi-agent-web/src/doctor-plugin.js";
import { debuggerDoctorPlugin } from "#src/plugins/pi-agent-ide-debugger/src/doctor-plugin.js";
import { startSshFixture } from "./ssh-fixture.js";
import { startSshWebFixture } from "./ssh-web-fixture.js";

/** Exercise target-only config publication and retain the actual guarded-write observations. */
export async function probeOwnedDoctorApply() {
  const fixture = await startSshFixture(
    {},
    {
      HOME: "{workspace}",
      PI_CODING_AGENT_DIR: "{workspace}/.cache/agent",
    },
  );
  try {
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const project = `ssh://fixture${fixture.workspace}`;
    const owner = requiredValue(registry.resolve(project));
    const workspace = await createSshDoctorWorkspace(registry, project);
    const file = (await workspace.configPaths("formatters")).project;
    const nativeFile = `${fixture.workspace}/.pi/pi-agent-ide/formatters.json`;
    const entry = {
      extensions: [".ts"],
      run: { command: ["owned", "{file}"] },
      output: "stdout" as const,
    };
    const candidate: RecipeCandidate = {
      pluginId: "formatter",
      score: 10,
      evidence: [],
      recipe: {
        id: "owned",
        name: "Owned",
        kind: "formatter",
        languages: ["typescript"],
        executables: ["owned"],
        documentation: "https://example.com/owned",
        formatter: entry,
      },
    };
    await workspace.writeText(
      file,
      JSON.stringify({ version: 1, formatters: { existing: entry } }),
      undefined,
    );
    const changed = await writeSuggestedConfigs(project, [candidate], workspace);
    const saved = requiredValue(await workspace.readText(file));
    const repeated = await writeSuggestedConfigs(project, [candidate], workspace);
    const global = (await workspace.configPaths("formatters")).global;
    const globalUntouched = !(await workspace.exists(global));
    const before = await owner.backend.read(nativeFile);
    const external = `${JSON.stringify({ version: 1, formatters: { external: entry } })}\n`;
    await owner.backend.write(nativeFile, Buffer.from(external), before.version);
    let conflictRetained = false;
    try {
      await workspace.writeText(file, saved, saved);
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "CONFLICT"
        )
      )
        throw error;
      conflictRetained = true;
    }
    return {
      root: fixture.root,
      project,
      file,
      changed,
      config: JSON.parse(saved) as unknown,
      idempotent: repeated.length === 0,
      globalUntouched,
      conflictRetained,
      externalPreserved: (await owner.backend.read(nativeFile)).bytes.toString("utf8") === external,
    };
  } finally {
    await fixture.stop();
  }
}

/** Check browser readiness through Doctor without navigating or relying on a reachable proxy. */
export async function probeOwnedDoctorBrowser(missing: boolean) {
  const fixture = await startSshWebFixture(
    "http://127.0.0.1:1",
    missing
      ? {
          PI_AGENT_IDE_PLAYWRIGHT_PATH: "{workspace}/not-installed",
        }
      : {},
  );
  try {
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const project = `ssh://fixture${fixture.workspace}`;
    const workspace = await createSshDoctorWorkspace(registry, project);
    const core = new DoctorCore();
    await core.registerPlugin(webDoctorPlugin);
    const result = await runDoctor(core.snapshot(), project, {}, undefined, workspace);
    return {
      root: fixture.root,
      project,
      findings: result.sections.find((section) => section.pluginId === "web-browser")?.findings,
    };
  } finally {
    await fixture.stop();
  }
}

/** Check native managed adapter paths and a missing interpreter without controller fallbacks. */
export async function probeOwnedDoctorDebugger() {
  const fixture = await startSshFixture(
    {},
    {
      PI_JS_DEBUG_PATH: "{workspace}/adapter#café.js",
      PI_PYTHON_PATH: "{workspace}/missing-python",
      PI_IDE_UNUSED_ENV: "not-a-tool-path",
    },
  );
  try {
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const project = `ssh://fixture${fixture.workspace}`;
    const owner = requiredValue(registry.resolve(project));
    for (const [name, content] of [
      ["adapter#café.js", "// Native adapter path used by the existing Doctor Node probe.\n"],
      ["note.ts", 'const label = "café";\n'],
      ["note.py", 'label = "café"\n'],
    ])
      await owner.backend.write(
        `${fixture.workspace}/${name}`,
        Buffer.from(requiredValue(content)),
        null,
      );
    const workspace = await createSshDoctorWorkspace(registry, project);
    const core = new DoctorCore();
    await core.registerPlugin({
      protocol: "pi-agent-ide-doctor",
      apiVersion: 1,
      id: "languages",
      setup(api) {
        api.addLanguage({ id: "typescript", name: "TypeScript", extensions: [".ts"] });
        api.addLanguage({ id: "python", name: "Python", extensions: [".py"] });
      },
    });
    await core.registerPlugin(debuggerDoctorPlugin);
    const result = await runDoctor(
      core.snapshot(),
      project,
      { PI_PYTHON_PATH: "/controller/python", PI_JS_DEBUG_PATH: "/controller/adapter.js" },
      undefined,
      workspace,
    );
    return {
      root: fixture.root,
      project,
      toolPaths: workspace.toolPaths,
      findings: result.sections.find((section) => section.pluginId === "debugger")?.findings,
      actions: result.actions,
    };
  } finally {
    await fixture.stop();
  }
}

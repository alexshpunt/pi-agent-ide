import { expect, test } from "vitest";

import { DoctorCore } from "./core.js";
import { runDoctor } from "./run.js";
import { formatterDoctorPlugin } from "#src/plugins/pi-agent-ide-formatter/src/doctor-plugin.js";
import { debuggerDoctorPlugin } from "#src/plugins/pi-agent-ide-debugger/src/doctor-plugin.js";
import { astDoctorPlugin } from "#src/plugins/pi-agent-ide-ast/src/doctor-plugin.js";
import { changesDoctorPlugin } from "#src/plugins/pi-agent-ide-changes/src/doctor-plugin.js";
import { webDoctorPlugin } from "#src/extensions/pi-agent-read/extensions/pi-agent-web/src/doctor-plugin.js";
import { visionDoctorPlugin } from "#src/plugins/pi-agent-ide-vision/src/doctor-plugin.js";
import { textSearchDoctorPlugin } from "#src/extensions/pi-agent-search/plugins/pi-agent-search-text/src/doctor-plugin.js";
import type { DoctorWorkspace } from "#src/api/doctor.js";
import { vi } from "vitest";

const project = "ssh://fixture/project";

function workspaceFixture(): DoctorWorkspace {
  const unavailable = () => {
    throw new Error("Unexpected owner operation");
  };
  return {
    source: project,
    platform: "linux",
    files: async () => [`${project}/note.ts`],
    configPaths: async (name) => ({
      project: `${project}/.pi/pi-agent-ide/${name}.json`,
      global: `ssh://fixture/home/agent/${name}.json`,
    }),
    readText: async (source) =>
      source === `${project}/.pi/pi-agent-ide/formatters.json`
        ? JSON.stringify({
            version: 1,
            formatters: {
              owned: {
                extensions: [".ts"],
                run: { command: ["owned-format", "{file}"] },
                output: "stdout",
              },
            },
          })
        : undefined,
    evidence: async () => new Map(),
    executableAvailability: async (configs) =>
      configs.map((config) => config.command[0] === "owned-format"),
    withProbeCopy: async (source, use) => use(`${source}-probe.ts`),
    run: vi.fn(async () => ({ ok: true, exitCode: 0, stdout: "const value = 43;\n", stderr: "" })),
    exists: unavailable,
    writeText: unavailable,
    start: unavailable,
    toNativeUri: unavailable,
    fromNativeUri: unavailable,
  };
}

async function formatterCore(): Promise<DoctorCore> {
  const core = new DoctorCore();
  await core.registerPlugin({
    protocol: "pi-agent-ide-doctor",
    apiVersion: 1,
    id: "language",
    setup: (api) => api.addLanguage({ id: "typescript", name: "TypeScript", extensions: [".ts"] }),
  });
  await core.registerPlugin(formatterDoctorPlugin);
  return core;
}

test("Doctor refuses an SSH project without its owner before controller filesystem access", async () => {
  await expect(
    runDoctor(new DoctorCore().snapshot(), "ssh://fixture/project"),
  ).rejects.toMatchObject({
    code: "UNSUPPORTED_SOURCE",
  });
});

test("Doctor selects and probes the formatter through the same project owner", async () => {
  const workspace = workspaceFixture();
  const core = await formatterCore();
  const result = await runDoctor(core.snapshot(), project, {}, undefined, workspace);
  expect(result.cwd).toBe(project);
  expect(result.files).toEqual([`${project}/note.ts`]);
  expect(result.selections).toContainEqual({
    kind: "formatter",
    languageId: "typescript",
    toolId: "owned",
    pluginId: "formatter",
  });
  expect(
    result.sections.find((section) => section.pluginId === "formatter")?.findings,
  ).toContainEqual({
    status: "pass",
    message: 'owned [project] command ["owned-format","{file}"]: probe passed',
    detail: `${project}/.pi/pi-agent-ide/formatters.json`,
  });
  expect(workspace.run).toHaveBeenCalledWith(
    { command: ["owned-format", "{file}"] },
    `${project}/note.ts-probe.ts`,
    undefined,
  );
});

test("Doctor probes Python and JavaScript adapters through the project owner", async () => {
  const workspace = workspaceFixture();
  vi.spyOn(workspace, "files").mockResolvedValue([`${project}/note.py`, `${project}/note.ts`]);
  vi.spyOn(workspace, "toNativeUri").mockImplementation((source) =>
    source.replace("ssh://fixture", "file://"),
  );
  vi.spyOn(workspace, "fromNativeUri").mockImplementation(
    (uri) => `ssh://fixture${decodeURIComponent(new URL(uri).pathname)}`,
  );
  vi.spyOn(workspace, "executableAvailability").mockImplementation(async (configs) =>
    configs.map(() => true),
  );
  const exists = vi.spyOn(workspace, "exists").mockResolvedValue(true);
  const run = vi.spyOn(workspace, "run").mockResolvedValue({
    ok: true,
    exitCode: 0,
    stdout: "Owned debugger version 42\n",
    stderr: "",
  });
  const core = new DoctorCore();
  await core.registerPlugin({
    protocol: "pi-agent-ide-doctor",
    apiVersion: 1,
    id: "languages",
    setup(api) {
      api.addLanguage({ id: "python", name: "Python", extensions: [".py"] });
      api.addLanguage({ id: "typescript", name: "TypeScript", extensions: [".ts"] });
    },
  });
  await core.registerPlugin(debuggerDoctorPlugin);
  const result = await runDoctor(core.snapshot(), project, {}, undefined, workspace);
  expect(result.sections.find((section) => section.pluginId === "debugger")?.findings).toEqual([
    { status: "pass", message: "debugpy: available", detail: "Owned debugger version 42" },
    {
      status: "pass",
      message: "vscode-js-debug: available",
      detail: "Owned debugger version 42",
    },
  ]);
  expect(run).toHaveBeenCalledWith(
    { command: ["python3", "-c", "import debugpy; print(debugpy.__version__)"], timeoutMs: 5_000 },
    project,
    undefined,
  );
  expect(run.mock.calls.some(([recipe]) => recipe.command[0] === "node")).toBe(true);
  expect(exists).toHaveBeenCalledWith(
    "ssh://fixture/opt/pi-debug-adapters/js-debug/src/dapDebugServer.js",
    undefined,
  );
});

test("Doctor parses the owned snapshot and checks structural search on its owner", async () => {
  const workspace = workspaceFixture();
  const readText = vi.spyOn(workspace, "readText").mockResolvedValue('const label = "café";\n');
  vi.spyOn(workspace, "executableAvailability").mockImplementation(async (configs) =>
    configs.map(() => true),
  );
  const run = vi
    .spyOn(workspace, "run")
    .mockResolvedValue({ ok: true, exitCode: 0, stdout: "owned ast-grep 42\n", stderr: "" });
  const core = new DoctorCore();
  await core.registerPlugin({
    protocol: "pi-agent-ide-doctor",
    apiVersion: 1,
    id: "languages",
    setup: (api) => api.addLanguage({ id: "typescript", name: "TypeScript", extensions: [".ts"] }),
  });
  await core.registerPlugin(astDoctorPlugin);
  const result = await runDoctor(core.snapshot(), project, {}, undefined, workspace);
  expect(result.sections.find((section) => section.title === "AST")?.findings).toEqual([
    { status: "pass", message: "typescript parser loaded", detail: `${project}/note.ts` },
  ]);
  expect(
    result.sections.find((section) => section.title === "Structural search")?.findings,
  ).toEqual([{ status: "pass", message: "ast-grep is available", detail: "owned ast-grep 42" }]);
  expect(readText).toHaveBeenCalledWith(`${project}/note.ts`, undefined);
  expect(run).toHaveBeenCalledWith(
    { command: ["ast-grep", "--version"], timeoutMs: 5_000 },
    project,
    undefined,
  );
});

test("Doctor checks Git and text search on their project owner rather than the controller", async () => {
  const workspace = workspaceFixture();
  const exists = vi.spyOn(workspace, "exists").mockResolvedValue(true);
  vi.spyOn(workspace, "executableAvailability").mockImplementation(async (configs) =>
    configs.map(() => true),
  );
  const run = vi
    .spyOn(workspace, "run")
    .mockResolvedValue({ ok: true, exitCode: 0, stdout: "Owned native version 42\n", stderr: "" });
  const core = new DoctorCore();
  await core.registerPlugin(changesDoctorPlugin);
  await core.registerPlugin(textSearchDoctorPlugin);
  const result = await runDoctor(core.snapshot(), project, {}, undefined, workspace);
  expect(exists).toHaveBeenCalledWith(`${project}/.git`, undefined);
  for (const id of ["changes", "search-text"]) {
    expect(result.sections.find((section) => section.pluginId === id)?.findings).toMatchObject([
      { status: "pass", detail: "Owned native version 42" },
    ]);
  }
  expect(run).toHaveBeenCalledWith(
    { command: ["git", "--version"], timeoutMs: 5_000 },
    project,
    undefined,
  );
  expect(run).toHaveBeenCalledWith(
    { command: ["rg", "--version"], timeoutMs: 5_000 },
    project,
    undefined,
  );
});

test("Doctor browser readiness comes from its owner and never a controller installation", async () => {
  const probeBrowser = vi.fn(async () => ({
    ok: true,
    detail: "Owned Playwright and Chromium started",
  }));
  const workspace = { ...workspaceFixture(), probeBrowser };
  const core = new DoctorCore();
  await core.registerPlugin(webDoctorPlugin);
  const result = await runDoctor(core.snapshot(), project, {}, undefined, workspace);
  expect(probeBrowser).toHaveBeenCalledWith(undefined);
  expect(
    result.sections.find((section) => section.pluginId === "web-browser")?.findings,
  ).toMatchObject([{ status: "pass", detail: "Owned Playwright and Chromium started" }]);
  const missing = await runDoctor(core.snapshot(), project, {}, undefined, workspaceFixture());
  expect(
    missing.sections.find((section) => section.pluginId === "web-browser")?.findings,
  ).toMatchObject([
    {
      status: "warn",
      message: "Browser reads are unavailable",
      detail: "Project owner does not provide a browser probe",
    },
  ]);
});

test("Doctor capture readiness uses its owner and does not mistake a missing probe for local success", async () => {
  const controller = new AbortController();
  const probeCapture = vi.fn(async () => ({
    display: { ok: true, detail: "Owned connection without pixels" },
    window: { ok: false, detail: "Owned trusted identity unavailable" },
  }));
  const core = new DoctorCore();
  await core.registerPlugin(visionDoctorPlugin);
  const result = await runDoctor(core.snapshot(), project, {}, controller.signal, {
    ...workspaceFixture(),
    probeCapture,
  });
  expect(probeCapture).toHaveBeenCalledWith(controller.signal);
  expect(result.sections.find((section) => section.pluginId === "vision")?.findings).toEqual([
    {
      status: "pass",
      message: "Native display connection",
      detail: "Owned connection without pixels",
    },
    {
      status: "warn",
      message: "Trusted native window identity",
      detail: "Owned trusted identity unavailable",
    },
  ]);
  const missing = await runDoctor(core.snapshot(), project, {}, undefined, workspaceFixture());
  expect(missing.sections.find((section) => section.pluginId === "vision")?.findings).toEqual([
    {
      status: "warn",
      message: "Native capture readiness is unavailable",
      detail: "Project owner does not provide a capture readiness probe",
    },
  ]);
  const reason = new Error("Cancel native capture readiness");
  probeCapture.mockImplementation(async () => {
    controller.abort(reason);
    throw reason;
  });
  await expect(
    runDoctor(core.snapshot(), project, {}, controller.signal, {
      ...workspaceFixture(),
      probeCapture,
    }),
  ).rejects.toBe(reason);
});
test.each([
  ["/native/adapter#café.js", "ssh://fixture/native/adapter#café.js"],
  ["adapter#café.js", `${project}/adapter#café.js`],
])("Doctor uses its native managed adapter path %s", async (adapter, source) => {
  const workspace = {
    ...workspaceFixture(),
    toolPaths: { PI_PYTHON_PATH: "owned-python", PI_JS_DEBUG_PATH: adapter },
  };
  vi.spyOn(workspace, "files").mockResolvedValue([`${project}/note.py`, `${project}/note.ts`]);
  vi.spyOn(workspace, "toNativeUri").mockImplementation((source) =>
    source.replace("ssh://fixture", "file://"),
  );
  vi.spyOn(workspace, "fromNativeUri").mockImplementation(
    (uri) => `ssh://fixture${decodeURIComponent(new URL(uri).pathname)}`,
  );
  vi.spyOn(workspace, "executableAvailability").mockImplementation(async (configs) =>
    configs.map(() => true),
  );
  const exists = vi.spyOn(workspace, "exists").mockResolvedValue(true);
  const run = vi
    .spyOn(workspace, "run")
    .mockResolvedValue({ ok: true, exitCode: 0, stdout: "native version", stderr: "" });
  const core = new DoctorCore();
  await core.registerPlugin({
    protocol: "pi-agent-ide-doctor",
    apiVersion: 1,
    id: "languages",
    setup(api) {
      api.addLanguage({ id: "python", name: "Python", extensions: [".py"] });
      api.addLanguage({ id: "typescript", name: "TypeScript", extensions: [".ts"] });
    },
  });
  await core.registerPlugin(debuggerDoctorPlugin);
  await runDoctor(
    core.snapshot(),
    project,
    { PI_PYTHON_PATH: "/controller/python" },
    undefined,
    workspace,
  );
  expect(run).toHaveBeenCalledWith(
    {
      command: ["owned-python", "-c", "import debugpy; print(debugpy.__version__)"],
      timeoutMs: 5_000,
    },
    project,
    undefined,
  );
  expect(exists).toHaveBeenCalledWith(source, undefined);
  expect(run.mock.calls.some(([recipe]) => recipe.command.includes("/controller/python"))).toBe(
    false,
  );
});

test("Doctor does not use controller environment overrides for a remote project", async () => {
  const core = new DoctorCore();
  const environments: NodeJS.ProcessEnv[] = [];
  await core.registerPlugin({
    protocol: "pi-agent-ide-doctor",
    apiVersion: 1,
    id: "environment",
    setup(api) {
      api.addSetupCheck({
        id: "environment",
        async inspect(context) {
          environments.push(context.env);
          return {};
        },
      });
      api.addCheck({
        id: "environment",
        title: "Environment",
        async run(context) {
          environments.push(context.env);
          return [];
        },
      });
    },
  });
  await runDoctor(
    core.snapshot(),
    project,
    { PI_AGENT_IDE_BROWSER_PATH: "/controller/browser", PI_JS_DEBUG_PATH: "/controller/adapter" },
    undefined,
    workspaceFixture(),
  );
  expect(environments).toEqual([{}, {}]);
});

test("Doctor retains cancellation raised during a contributed native check instead of returning a failure report", async () => {
  const controller = new AbortController();
  const reason = new Error("Cancel Doctor during owned check");
  const core = new DoctorCore();
  await core.registerPlugin({
    protocol: "pi-agent-ide-doctor",
    apiVersion: 1,
    id: "cancelled-check",
    setup(api) {
      api.addCheck({
        id: "cancelled",
        title: "Cancelled",
        async run() {
          controller.abort(reason);
          throw reason;
        },
      });
    },
  });
  await expect(
    runDoctor(core.snapshot(), project, {}, controller.signal, workspaceFixture()),
  ).rejects.toBe(reason);
});

test("Doctor retains cancellation before inventory and rejects a mismatched owner", async () => {
  const workspace = workspaceFixture();
  const files = vi.spyOn(workspace, "files");
  const controller = new AbortController();
  const reason = new Error("Cancel owned Doctor");
  controller.abort(reason);
  await expect(
    runDoctor(new DoctorCore().snapshot(), project, {}, controller.signal, workspace),
  ).rejects.toBe(reason);
  expect(files).not.toHaveBeenCalled();
  await expect(
    runDoctor(new DoctorCore().snapshot(), "ssh://other/project", {}, undefined, workspace),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
  expect(files).not.toHaveBeenCalled();
});

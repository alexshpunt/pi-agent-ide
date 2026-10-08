import path from "node:path";
import { requiredValue } from "pi-agent-invariant";
import { expect, test } from "vitest";
import { DoctorCore } from "#src/doctor/core.js";
import { runDoctor } from "#src/doctor/run.js";
import { formatterDoctorPlugin } from "#src/plugins/pi-agent-ide-formatter/src/doctor-plugin.js";
import { lintDoctorPlugin } from "#src/plugins/pi-agent-ide-lint/src/doctor-plugin.js";
import { lspDoctorPlugin } from "#src/plugins/pi-agent-ide-lsp/src/doctor-plugin.js";
import { createSshDoctorWorkspace } from "#src/backend/doctor-workspace.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { startSshFixture } from "./support/ssh-fixture.js";
import { probeOwnedDoctorApply, probeOwnedDoctorBrowser } from "./support/ssh-doctor-probe.js";
import { probeOwnedDoctorDebugger } from "./support/ssh-doctor-probe.js";
function gate() {
  const callbacks: { resolve?: () => void; reject?: (reason?: unknown) => void } = {};
  const promise = new Promise<void>((resolve, reject) => {
    callbacks.resolve = resolve;
    callbacks.reject = reject;
  });
  return {
    promise,
    resolve: requiredValue(callbacks.resolve),
    reject: requiredValue(callbacks.reject),
  };
}

test("Doctor uses native project and user-global tools, cleans every probe and keeps the original source", async () => {
  const fixture = await startSshFixture(
    {
      "owned-doctor": path.resolve("tests/integration/fixtures/doctor-owner-tool.py"),
      "owned-lsp": path.resolve("tests/integration/fixtures/lsp-owner-server.py"),
    },
    { HOME: "{workspace}", PI_CODING_AGENT_DIR: "{workspace}/.cache/agent" },
  );
  try {
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const project = `ssh://fixture${fixture.workspace}`;
    const owner = registry.resolve(project);
    if (!owner) throw new Error("Missing fixture owner");
    const original = "const value = 42; // café\n";
    const put = (file: string, content: unknown) =>
      owner.backend.write(
        `${fixture.workspace}/${file}`,
        Buffer.from(typeof content === "string" ? content : JSON.stringify(content)),
        null,
      );
    await put("note.ts", original);
    const env = { PI_IDE_DOCTOR_MARKER: `${fixture.workspace}/probe-pids` };
    await put(".pi/pi-agent-ide/formatters.json", {
      version: 1,
      formatters: {
        owned: {
          extensions: [".ts"],
          output: "in-place",
          run: { command: ["owned-doctor", "format", "{file}"], env },
        },
      },
    });
    await put(".cache/agent/extensions/pi-agent-ide/linters.json", {
      version: 1,
      linters: {
        owned: {
          extensions: [".ts"],
          check: { command: ["owned-doctor", "lint", "{file}"], env },
          diagnostics: { format: "pi-json" },
        },
      },
    });
    await put(".pi/pi-agent-ide/lsp-servers.json", {
      version: 1,
      servers: {
        owned: {
          command: ["owned-lsp"],
          rootMarkers: [],
          languages: { typescript: { extensions: [".ts"] } },
          capabilities: ["diagnostics"],
          initializationOptions: { ownerInitializeMarker: `${fixture.workspace}/lsp.pid` },
        },
      },
    });
    const core = new DoctorCore();
    await core.registerPlugin({
      protocol: "pi-agent-ide-doctor",
      apiVersion: 1,
      id: "language",
      setup: (api) =>
        api.addLanguage({ id: "typescript", name: "TypeScript", extensions: [".ts"] }),
    });
    for (const plugin of [formatterDoctorPlugin, lintDoctorPlugin, lspDoctorPlugin])
      await core.registerPlugin(plugin);
    const workspace = await createSshDoctorWorkspace(registry, project);
    const result = await runDoctor(core.snapshot(), project, {}, undefined, workspace);
    expect(result.files).toEqual([`${project}/note.ts`]);
    for (const kind of ["formatter", "linter", "lsp"])
      expect(result.selections).toContainEqual({
        kind,
        languageId: "typescript",
        toolId: "owned",
        pluginId: kind === "linter" ? "lint" : kind,
      });
    for (const pluginId of ["formatter", "lint", "lsp"]) {
      const findings = result.sections.find((section) => section.pluginId === pluginId)?.findings;
      expect(findings).toHaveLength(1);
      expect(findings).toMatchObject([{ status: "pass" }]);
    }
    expect(
      result.sections.find((section) => section.pluginId === "lint")?.findings[0]?.detail,
    ).toBe(`${project}/.cache/agent/extensions/pi-agent-ide/linters.json`);
    expect((await owner.backend.read(`${fixture.workspace}/note.ts`)).bytes.toString("utf8")).toBe(
      original,
    );
    await expect(owner.backend.stat(`${fixture.workspace}/.tmp`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const name of ["probe-pids-format", "probe-pids-lint", "lsp.pid"]) {
      const text = (await owner.backend.read(`${fixture.workspace}/${name}`)).bytes.toString(
        "utf8",
      );
      const values: unknown = JSON.parse(text);
      const pids = Array.isArray(values) ? values : [values];
      expect(pids).toHaveLength(1);
      for (const pid of pids) {
        if (typeof pid !== "number") throw new Error("Invalid recorded native PID");
        await expect(readSshProcessMetadata(registry, project, pid)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
  } finally {
    await fixture.stop();
  }
});

test("Doctor applies only target project config and refuses an externally changed native snapshot", async () => {
  const result = await probeOwnedDoctorApply();
  expect(result.changed).toEqual([result.file]);
  expect(result.config).toMatchObject({
    formatters: {
      existing: { run: { command: ["owned", "{file}"] } },
      owned: { run: { command: ["owned", "{file}"] } },
    },
  });
  expect(result).toMatchObject({
    idempotent: true,
    globalUntouched: true,
    conflictRetained: true,
    externalPreserved: true,
  });
});

test.each([false, true])(
  "Doctor checks native browser startup without network and reports a missing target runtime (missing=%s)",
  async (missing) => {
    const result = await probeOwnedDoctorBrowser(missing);
    expect(result.findings).toMatchObject(
      missing
        ? [
            {
              status: "warn",
              message: "Browser reads are unavailable",
              detail: `CAPABILITY_UNAVAILABLE: ${result.project}`,
            },
          ]
        : [{ status: "pass", detail: "Target Playwright and Chromium started without navigation" }],
    );
  },
);

test("overlapping native Doctor probes keep their sibling and remove only their newly created container", async () => {
  const fixture = await startSshFixture();
  const firstReady = gate();
  const secondReady = gate();
  const firstRelease = gate();
  const secondRelease = gate();
  const pending: Promise<string>[] = [];
  try {
    const registry = new SshBackendRegistry([
      { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
    ]);
    const project = `ssh://fixture${fixture.workspace}`;
    const owner = registry.resolve(project);
    if (!owner) throw new Error("Missing fixture owner");
    await owner.backend.write(
      `${fixture.workspace}/note.ts`,
      Buffer.from("const value = 42;\n"),
      null,
    );
    const workspace = await createSshDoctorWorkspace(registry, project);
    const first = workspace.withProbeCopy(`${project}/note.ts`, async () => {
      firstReady.resolve();
      await firstRelease.promise;
      return "first";
    });
    pending.push(first);
    void first.catch(firstReady.reject);
    await firstReady.promise;
    const second = workspace.withProbeCopy(`${project}/note.ts`, async (probe) => {
      secondReady.resolve();
      await secondRelease.promise;
      expect(await workspace.readText(probe)).toBe("const value = 42;\n");
      return "second";
    });
    pending.push(second);
    void second.catch(secondReady.reject);
    await secondReady.promise;
    firstRelease.resolve();
    await expect(first).resolves.toBe("first");
    expect(await owner.backend.list(`${fixture.workspace}/.tmp`)).toHaveLength(1);
    secondRelease.resolve();
    await expect(second).resolves.toBe("second");
    await expect(owner.backend.stat(`${fixture.workspace}/.tmp`)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await owner.backend.execute("mkdir", [`${fixture.workspace}/.tmp`], fixture.workspace);
    await workspace.withProbeCopy(`${project}/note.ts`, async () => "existing-container");
    expect(await owner.backend.list(`${fixture.workspace}/.tmp`)).toEqual([]);
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await Promise.allSettled(pending);
    await fixture.stop();
  }
});

test("Doctor uses only native managed debugger paths and reports a missing native interpreter", async () => {
  const proof = await probeOwnedDoctorDebugger();
  expect(proof.toolPaths).toEqual({
    PI_JS_DEBUG_PATH: `${proof.root}/workspace/adapter#café.js`,
    PI_PYTHON_PATH: `${proof.root}/workspace/missing-python`,
  });
  const available = proof.findings?.find(
    (finding) => finding.message === "vscode-js-debug: available",
  );
  expect(available?.status).toBe("pass");
  expect(available?.detail).toMatch(/^v\d+/u);
  const missing = proof.findings?.find((finding) => finding.message === "debugpy: unavailable");
  expect(missing?.status).toBe("fail");
  expect(typeof missing?.detail).toBe("string");
  expect(proof.actions.find((action) => action.category === "missing-runtime")?.message).toContain(
    `${proof.root}/workspace/missing-python`,
  );
  expect(JSON.stringify(proof)).not.toContain("/controller/");
}, 30_000);

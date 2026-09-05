import { describe, expect, it } from "vitest";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";

import { DoctorCore, runContributedSetupChecks } from "./core.js";

import type { DoctorPlugin } from "pi-agent-doctor/api/plugin-protocol";

describe("doctor contribution core", () => {
  it("keeps contributions owned by their independent plugin", async () => {
    const core = new DoctorCore();
    await core.registerPlugin(
      plugin("language-owner", (api) =>
        api.addLanguage({ id: "fixture", name: "Fixture", extensions: [".fixture"] }),
      ),
    );
    await core.registerPlugin(
      plugin("tool-owner", (api) =>
        api.addToolRecipe({
          id: "fixture-format",
          name: "Fixture format",
          kind: "formatter",
          languages: ["fixture"],
          executables: ["fixture-format"],
          documentation: "https://example.com",
          formatter: {
            extensions: [".fixture"],
            run: { command: ["fixture-format", "{file}"] },
            output: "in-place",
          },
        }),
      ),
    );

    expect(core.snapshot().languages).toMatchObject([
      { pluginId: "language-owner", value: { id: "fixture" } },
    ]);
    await core.registerPlugin(
      plugin("setup-owner", (api) =>
        api.addSetupCheck({ id: "fixture-setup", inspect: async () => ({ actions: [] }) }),
      ),
    );

    expect(core.snapshot().recipes).toMatchObject([
      { pluginId: "tool-owner", value: { id: "fixture-format" } },
    ]);

    expect(core.snapshot().setupChecks).toMatchObject([
      { pluginId: "setup-owner", value: { id: "fixture-setup" } },
    ]);
  });

  it("does not expose contributions from a plugin that was never registered", async () => {
    const core = new DoctorCore();
    await core.registerPlugin(
      plugin("loaded", (api) =>
        api.addCheck({ id: "loaded", title: "Loaded", run: async () => [] }),
      ),
    );
    expect(core.snapshot().checks.map((entry) => entry.pluginId)).toEqual(["loaded"]);
  });

  it("does not turn an internal setup inspection failure into user guidance", async () => {
    const core = new DoctorCore();
    await core.registerPlugin(
      plugin("broken", (api) =>
        api.addSetupCheck({
          id: "broken",
          inspect: async () => {
            throw new Error("broken inspector");
          },
        }),
      ),
    );

    await expect(
      runContributedSetupChecks(core.snapshot(), {
        cwd: "/project",
        files: [],
        detectedLanguageIds: new Set(),
        detectedLanguages: new Map(),
        env: {},
      }),
    ).resolves.toEqual({ selections: [], actions: [] });
  });

  it("rejects catalog ID collisions across independent plugins", async () => {
    const core = new DoctorCore();
    await core.registerPlugin(
      plugin("first", (api) =>
        api.addLanguage({ id: "fixture", name: "Fixture", extensions: [".one"] }),
      ),
    );
    await expect(
      core.registerPlugin(
        plugin("second", (api) =>
          api.addLanguage({ id: "fixture", name: "Other", extensions: [".two"] }),
        ),
      ),
    ).rejects.toThrow("already owned");
  });
});

function plugin(id: string, setup: DoctorPlugin["setup"]): DoctorPlugin {
  return { protocol: DOCTOR_PROTOCOL, apiVersion: DOCTOR_API_VERSION, id, setup };
}

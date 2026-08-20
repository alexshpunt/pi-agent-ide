import { describe, expect, it } from "vitest";

import { DOCTOR_API_VERSION, DOCTOR_PROTOCOL } from "pi-agent-doctor/api/plugin-protocol";

import { DoctorCore } from "./core.js";

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
    expect(core.snapshot().recipes).toMatchObject([
      { pluginId: "tool-owner", value: { id: "fixture-format" } },
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

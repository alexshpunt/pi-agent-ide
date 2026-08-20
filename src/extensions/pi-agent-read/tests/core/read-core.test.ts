import { expect, test } from "vitest";

import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
  type ReadPluginApi,
} from "#src/api/plugin-protocol.js";
import { createReadCore } from "#src/core/read-core.js";

test("renders static descriptions and evaluates lazy descriptions for each snapshot", async () => {
  const core = createReadCore();
  let current: string | undefined = "Reads current fixture content.";
  let calls = 0;

  await core.registerPlugin(
    plugin("static", (api) => {
      api.describe("Reads static fixture content.");
    }),
  );
  await core.registerPlugin(
    plugin("lazy", (api) => {
      api.describe(() => {
        calls += 1;
        return current;
      });
    }),
  );

  expect(core.renderPluginPromptGuideline()).toBe(
    [
      "Read supports these installed protocols:",
      "  - `static` — Reads static fixture content.",
      "  - `lazy` — Reads current fixture content.",
    ].join("\n"),
  );
  expect(calls).toBe(1);

  current = undefined;
  expect(core.renderPluginPromptGuideline()).toBe(
    [
      "Read supports these installed protocols:",
      "  - `static` — Reads static fixture content.",
    ].join("\n"),
  );
  expect(calls).toBe(2);

  current = "Reads changed fixture content.";
  expect(core.renderPluginPromptGuideline()).toContain("Reads changed fixture content.");
  expect(calls).toBe(3);
});

test("fails prompt construction for invalid or throwing lazy descriptions", async () => {
  const invalidCore = createReadCore();
  await invalidCore.registerPlugin(
    plugin("invalid", (api) => {
      api.describe(() => 42 as never);
    }),
  );
  expect(() => invalidCore.renderPluginPromptGuideline()).toThrow(/description/u);

  const throwingCore = createReadCore();
  const failure = new Error("broken description");
  await throwingCore.registerPlugin(
    plugin("throwing", (api) => {
      api.describe(() => {
        throw failure;
      });
    }),
  );
  expect(() => throwingCore.renderPluginPromptGuideline()).toThrow(failure);
});

test("rejects a second description without committing the failed setup", async () => {
  const core = createReadCore();

  await expect(
    core.registerPlugin(
      plugin("duplicate", (api) => {
        api.describe("First.");
        api.describe(() => "Second.");
      }),
    ),
  ).rejects.toThrow(/more than one description/u);
  expect(core.renderPluginPromptGuideline()).toBeUndefined();
});

function plugin(id: string, setup: (api: ReadPluginApi) => void): ReadPlugin {
  return {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id,
    setup,
  };
}

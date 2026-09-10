import { expect, test, vi } from "vitest";
import { createFeatureFlags } from "./feature-flags.js";

test("feature registration supplies discovery and saved defaults together", () => {
  const registerFlag = vi.fn();
  const flags = createFeatureFlags({ registerFlag }, { future: true });
  const feature = {
    id: "future",
    name: "Future feature",
    description: "A dynamically registered feature.",
    default: false,
  };
  flags.register(feature);
  expect(flags.definitions).toEqual([feature]);
  expect(registerFlag).toHaveBeenCalledWith("future", {
    type: "boolean",
    description: feature.description,
    default: true,
  });
  expect(() => flags.register(feature)).toThrow(/Duplicate/);
});

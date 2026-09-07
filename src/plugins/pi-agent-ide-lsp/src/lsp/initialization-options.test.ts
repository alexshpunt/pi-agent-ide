import { expect, test } from "vitest";
import { resolveInitializationOptions } from "./initialization-options.js";

test("expands nested plugin paths without mutating options or interpreting dollar signs", () => {
  const options = {
    plugins: [{ location: "{project}/node_modules/plugin", languages: ["vue"] }],
    enabled: true,
    count: 1,
    nullable: null,
  };
  const root = "C:\\project with spaces\\$&";
  expect(resolveInitializationOptions(options, root)).toEqual({
    ...options,
    plugins: [{ location: `${root}/node_modules/plugin`, languages: ["vue"] }],
  });
  expect(options.plugins[0]?.location).toBe("{project}/node_modules/plugin");
});

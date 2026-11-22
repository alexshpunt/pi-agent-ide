import { expect, test } from "vitest";
import { ResultTargetStore } from "pi-agent-resource";
import { createSearchCore } from "#src/core/search-core.ts";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "#src/api/plugin-protocol.ts";
import {
  describeSearchParameters,
  searchPathDescription,
  searchSchema,
} from "#src/api/search-parameters.ts";

const resolver = (id: string) => ({
  resolver: {
    id,
    tryResolve: () => ({ kind: "not-handled" as const }),
    format: () => ({ content: [], details: {} }),
  },
});

test("the path field lists descriptions of active plugins after the core text", async () => {
  const core = createSearchCore(new ResultTargetStore());
  await core.registerPlugin({
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "tickets",
    setup(api) {
      api.addResolver(resolver("tickets"));
      api.describe("Use `ticket:<id>` to find an issue tracker ticket.");
    },
  });
  await core
    .registerPlugin({
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "broken",
      setup(api) {
        api.describe("Search broken sources.");
        throw new Error("setup failed");
      },
    })
    .catch(() => undefined);

  expect(describeSearchParameters(core.renderDescriptions()).properties.path).toMatchObject({
    description: `${searchPathDescription}\nUse \`ticket:<id>\` to find an issue tracker ticket.`,
  });
});

test("without plugin descriptions the schema stays unchanged", () => {
  expect(describeSearchParameters([])).toBe(searchSchema);
  expect(describeSearchParameters(["same", "same\n"])).toMatchObject({
    properties: { path: { description: `${searchPathDescription}\nsame` } },
  });
});

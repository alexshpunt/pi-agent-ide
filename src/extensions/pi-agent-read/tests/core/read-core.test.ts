import { expect, test } from "vitest";
import { Value } from "typebox/value";

import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
  type ReadPluginApi,
} from "#src/api/plugin-protocol.js";
import { readParameters, describeReadParameters } from "#src/api/read-parameters.js";
import { createReadCore } from "#src/core/read-core.js";

test("puts plugin syntax on its parameter without changing accepted arguments", async () => {
  const core = createReadCore();
  await core.registerPlugin(
    plugin("source", (api) => {
      api.describe({
        path: "example:<id> reads a source.",
        views: "outline returns declarations.",
      });
    }),
  );
  const schema = core.read.tool.parameters;
  expect(description(schema, "path")).toContain("example:<id>");
  expect(description(schema, "path")).not.toContain("outline");
  expect(description(schema, "views")).toContain("outline");
  expect(description(schema, "offset")).not.toContain("example:<id>");
  expect(core.read.tool.description).not.toContain("example:<id>");
  expect(core.read.tool.promptGuidelines?.join("\n")).not.toContain("example:<id>");
  for (const request of [
    {},
    { path: "example:x", views: ["outline:depth=2"] },
    { offset: -3, limit: 0 },
  ]) {
    expect(Value.Check(schema, request)).toBe(Value.Check(readParameters, request));
  }
  expect(description(readParameters, "path")).not.toContain("example:<id>");
});

test("evaluates lazy parameter descriptions again for each schema snapshot", async () => {
  const core = createReadCore();
  let current: string | undefined = "image:scale=0.5";
  let calls = 0;
  const dynamic = plugin("lazy", (api) => {
    api.describe({
      views: () => {
        calls += 1;
        return current;
      },
    });
  });
  await core.registerPlugin(dynamic);
  await core.registerPlugin(dynamic);
  expect(calls).toBe(0);
  const first = core.read.tool.parameters;
  expect(description(first, "views")).toContain(current);
  expect(calls).toBe(1);
  current = undefined;
  expect(description(core.read.tool.parameters, "views")).not.toContain("image:scale");
  expect(calls).toBe(2);
  current = "image:scale=0.75";
  expect(description(core.read.tool.parameters, "views")).toContain(current);
  expect(calls).toBe(3);
  expect(description(first, "views")).not.toContain(current);
});

test("omits metadata from pending and failed setup", async () => {
  const core = createReadCore();
  let finish: () => void = () => {
    throw new Error("Setup has not started");
  };
  const ready = core.registerPlugin(
    plugin("pending", async (api) => {
      api.describe({ path: "pending-source:" });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    }),
  );
  await Promise.resolve();
  expect(description(core.read.tool.parameters, "path")).not.toContain("pending-source:");
  finish();
  await ready;
  expect(description(core.read.tool.parameters, "path")).toContain("pending-source:");
  await expect(
    core.registerPlugin(
      plugin("failed", (api) => {
        api.describe({ views: "failed-view" });
        throw new Error("setup failed");
      }),
    ),
  ).rejects.toThrow("setup failed");
  expect(description(core.read.tool.parameters, "views")).not.toContain("failed-view");
});

test("rejects duplicate, empty and unknown parameter descriptions atomically", async () => {
  for (const describe of [
    (api: ReadPluginApi) => {
      api.describe({ path: "First." });
      api.describe({ path: "Second." });
    },
    (api: ReadPluginApi) => {
      api.describe({});
    },
    (api: ReadPluginApi) => {
      api.describe({ path: "" });
    },
    (api: ReadPluginApi) => {
      api.describe({ unknown: "First." } as never);
    },
  ]) {
    const core = createReadCore();
    await expect(core.registerPlugin(plugin("invalid", describe))).rejects.toThrow(/description/u);
    expect(core.read.tool.parameters).toEqual(describeReadParameters({}));
  }
});

test("surfaces invalid or throwing lazy descriptions instead of hiding capabilities", async () => {
  for (const render of [
    () => 42 as never,
    () => {
      throw new Error("broken description");
    },
  ]) {
    const core = createReadCore();
    await core.registerPlugin(
      plugin("invalid", (api) => {
        api.describe({ views: render });
      }),
    );
    expect(() => core.read.tool.parameters).toThrow(/description/u);
  }
});

function plugin(id: string, setup: (api: ReadPluginApi) => void | Promise<void>): ReadPlugin {
  return { protocol: READ_PROTOCOL, apiVersion: READ_API_VERSION, id, setup };
}

function description(
  schema: typeof readParameters,
  parameter: keyof typeof readParameters.properties,
): string {
  const metadata = schema.properties[parameter] as { description?: unknown };
  expect(typeof metadata.description).toBe("string");
  return String(metadata.description);
}

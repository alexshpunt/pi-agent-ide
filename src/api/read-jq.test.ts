import { DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { ResourceError, type AgentContent } from "pi-agent-resource";
import { createTextDocument } from "pi-agent-text";
import { afterEach, expect, test, vi } from "vitest";

import { createReadTool } from "#src/extensions/pi-agent-read/src/core/tools/tool-read.js";
import { createJqReadHandler, type ReadPipelineContext, type ReadToolResult } from "./read.js";

const source = "fixture://json/card";
const rendered = "# Fixture card\nAn acquired JSON payload has a separate presentation.\n";
const pluginId = "json-fixture";
const readers = new Set<ReturnType<typeof createReadTool>>();

afterEach(async () => {
  await Promise.all([...readers].map((read) => read.dispose()));
  readers.clear();
});

function canonical(result: ReadToolResult): string {
  expect(result.isError).not.toBe(true);
  expect(result.script?.kind).toBe("text");
  if (result.script?.kind !== "text") throw new Error("Missing canonical text");
  return result.script.content.replaceAll("\r\n", "\n");
}

function provider(
  data: unknown = { id: "selected", hidden: "not-selected" },
  text = rendered,
  next?: () => unknown,
) {
  const read = createReadTool();
  readers.add(read);
  const payloads = new WeakMap<object, string>();
  const input = vi.fn((context: ReadPipelineContext) => {
    const block = context.state?.content[0];
    return block === undefined ? undefined : payloads.get(block);
  });
  const postRead = vi.fn((context: ReadPipelineContext) => ({
    kind: "continue" as const,
    context,
  }));
  const acquire = vi.fn((): AgentContent => {
    const block = { type: "text" as const, text };
    payloads.set(block, JSON.stringify(next === undefined ? data : next()));
    return [block];
  });
  read.registerContributions(`${pluginId}-provenance`, {
    handlers: [
      {
        stage: "read",
        when: { resolvedBy: pluginId, contentKind: "text" },
        handler(context) {
          const state = context.state;
          if (state?.contentKind !== "text") return { kind: "continue", context };
          return {
            kind: "continue",
            context: {
              ...context,
              state: {
                ...state,
                text: {
                  ...state.text,
                  references: [{ value: "fixture:original", kind: "fixture" }],
                  lines: state.text.lines.map((line) => ({
                    ...line,
                    anchors: ["fixture:original"],
                  })),
                },
              },
            },
          };
        },
      },
    ],
  });
  read.registerContributions(pluginId, {
    resolvers: [
      {
        resolver: {
          id: pluginId,
          async tryResolve(path) {
            if (path !== source && path !== `${source}#fields`) return { kind: "not-handled" };
            return {
              kind: "resolved",
              resource: {
                source: path,
                sourceBytes: Buffer.from(text),
                read: async () => acquire(),
              },
            };
          },
        },
      },
    ],
    views: [{ view: "jq", presenter: { id: pluginId, present: (document) => document } }],
    handlers: [
      {
        stage: "read",
        when: { resolvedBy: pluginId, contentKind: "any" },
        handler: createJqReadHandler({ pluginId, input }),
      },
      { stage: "post-read", handler: postRead },
    ],
  });
  return { read, input, acquire, postRead };
}

test("the public jq handler filters acquired JSON instead of rendered card text", async () => {
  const fixture = provider();
  const result = await fixture.read.execute(
    { path: source, views: ["jq:.id"] },
    { cwd: process.cwd() },
  );
  expect(JSON.parse(canonical(result))).toBe("selected");
  expect(fixture.acquire).toHaveBeenCalledTimes(1);
  expect(fixture.input).toHaveBeenCalledTimes(1);
});

test("concurrent acquisitions of one URI retain their own JSON payload", async () => {
  let id = 0;
  const fixture = provider(undefined, rendered, () => ({ id: ++id }));
  const results = await Promise.all([
    fixture.read.execute({ path: source, views: ["jq:.id"] }, { cwd: process.cwd() }),
    fixture.read.execute({ path: source, views: ["jq:.id"] }, { cwd: process.cwd() }),
  ]);
  const values = results.map((result) => {
    const value: unknown = JSON.parse(canonical(result));
    return value;
  });
  expect(values.sort()).toEqual([1, 2]);
  expect(fixture.acquire).toHaveBeenCalledTimes(2);
  expect(fixture.input).toHaveBeenCalledTimes(2);
});

test("identity jq clears provenance even when canonical output is unchanged", async () => {
  const content = '{\n  "id": "selected"\n}\n';
  const fixture = provider({ id: "selected" }, content);
  const result = await fixture.read.execute(
    { path: source, views: ["jq:."] },
    { cwd: process.cwd() },
  );
  expect(canonical(result)).toBe(content);
  expect(fixture.postRead).toHaveBeenCalledTimes(1);
  const context = fixture.postRead.mock.calls[0]?.[0];
  expect(context?.sourceText).toBeUndefined();
  expect(context?.sourceTarget).toBeUndefined();
  expect(result.script?.kind === "text" && result.script.references).toBeUndefined();
  expect(
    result.script?.kind === "text" &&
      result.script.lines.every((line) => line.anchors === undefined),
  ).toBe(true);
});

test("ordinary provider Reads keep their unchanged source provenance", async () => {
  const fixture = provider();
  const result = await fixture.read.execute({ path: source }, { cwd: process.cwd() });
  expect(canonical(result)).toBe(rendered);
  expect(fixture.input).not.toHaveBeenCalled();
  expect(fixture.postRead.mock.calls[0]?.[0].sourceText).toBe(rendered);
  expect(result.script?.kind === "text" && result.script.references).toEqual([
    { value: "fixture:original", kind: "fixture" },
  ]);
});

test.each([
  { filter: ".id, .hidden", offset: 2, limit: 1, expected: '"not-selected"\n' },
  { filter: "empty", expected: "" },
  { filter: "null", expected: "null\n" },
])("jq output windows and cardinality stay honest ($filter)", async (row) => {
  const fixture = provider();
  const result = await fixture.read.execute(
    { path: source, views: [`jq:${row.filter}`], offset: row.offset, limit: row.limit },
    { cwd: process.cwd() },
  );
  expect(canonical(result)).toBe(row.expected);
});

test.each([
  { views: ["jq"] },
  { views: ["jq:"] },
  { views: ["jq:.id", "jq:.hidden"] },
  { views: ["jq:.id", "anchors"] },
  { views: ["jq:("] },
])("invalid jq requests fail without returning the unfiltered card (%j)", async ({ views }) => {
  const fixture = provider();
  const result = await fixture.read.execute({ path: source, views }, { cwd: process.cwd() });
  expect(result.isError).toBe(true);
  expect(result.details.failure).toMatchObject({
    code: "READ_FAILED",
    source,
    pluginId,
    stage: "read",
  });
  expect(result.script).toBeUndefined();
  expect(result.content).not.toEqual([{ type: "text", text: rendered }]);
});

test("unsupported acquired content is an explicit failure, not JSON null", async () => {
  const input = vi.fn(() => undefined);
  const handler = createJqReadHandler({ pluginId, input });
  const unregistered = '{"id":"not-registered"}';
  const context: ReadPipelineContext = {
    inputScope: "source",
    request: { path: source, views: ["jq:."] },
    resolverContext: { cwd: process.cwd() },
    state: {
      source,
      resolvedBy: pluginId,
      contentKind: "text",
      content: [{ type: "text", text: unregistered }],
      text: createTextDocument(source, unregistered),
      preserveTruncatedOutput: false,
      textMode: "normal",
    },
  };
  const result = await handler(context);
  expect(result).toMatchObject({
    kind: "return",
    result: { isError: true, details: { failure: { code: "UNSUPPORTED_CONTENT", pluginId } } },
  });
  expect(input).toHaveBeenCalledTimes(1);
  const native = await handler({
    ...context,
    state: {
      source,
      resolvedBy: pluginId,
      contentKind: "other",
      content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      preserveTruncatedOutput: false,
      textMode: "normal",
    },
  });
  expect(native).toMatchObject({
    kind: "return",
    result: { isError: true, details: { failure: { code: "UNSUPPORTED_CONTENT" } } },
  });
  expect(input).toHaveBeenCalledTimes(1);
});

test.each(["RESULT#bounded", "SEARCH#bounded"])(
  "bounded %s cannot query unseen JSON",
  async (reference) => {
    const fixture = provider();
    fixture.read.registerContributions("scope", {
      targetResolvers: [
        {
          resolver: {
            id: "scope",
            tryResolve: (path) =>
              path === reference
                ? {
                    kind: "resolved",
                    targets: [
                      {
                        source,
                        ranges: [
                          {
                            start: { lineNumber: 1, column: 0 },
                            end: { lineNumber: 2, column: 0 },
                          },
                        ],
                      },
                    ],
                  }
                : { kind: "not-handled" },
          },
        },
      ],
    });
    const result = await fixture.read.execute(
      { path: reference, views: ["jq:.hidden"] },
      { cwd: process.cwd() },
    );
    expect(result.isError).toBe(true);
    expect(result.details.failure).toMatchObject({ code: "UNSUPPORTED_RANGE", pluginId });
    expect(fixture.input).not.toHaveBeenCalled();
    expect(result.script).toBeUndefined();
  },
);

test("an ordinary Read does not require a JSON scope marker", async () => {
  const fixture = provider();
  fixture.read.registerContributions("unclassified-host", {
    handlers: [
      {
        stage: "pre-read",
        handler: (context) => ({
          kind: "continue",
          context: { ...context, inputScope: undefined },
        }),
      },
    ],
  });
  const result = await fixture.read.execute({ path: source }, { cwd: process.cwd() });
  expect(canonical(result)).toBe(rendered);
  expect(fixture.input).not.toHaveBeenCalled();
  expect(fixture.acquire).toHaveBeenCalledTimes(1);
});

test("an unclassified input from an older host fails before querying JSON", async () => {
  const fixture = provider();
  fixture.read.registerContributions("unclassified-host", {
    handlers: [
      {
        stage: "pre-read",
        handler: (context) => ({
          kind: "continue",
          context: { ...context, inputScope: undefined },
        }),
      },
    ],
  });
  const result = await fixture.read.execute(
    { path: source, views: ["jq:.hidden"] },
    { cwd: process.cwd() },
  );
  expect(result.isError).toBe(true);
  expect(result.details.failure).toMatchObject({ code: "READ_FAILED", pluginId });
  expect(fixture.input).not.toHaveBeenCalled();
  expect(result.script).toBeUndefined();
});

test("text-anchor fallback cannot query a complete JSON payload", async () => {
  const fixture = provider();
  fixture.read.registerContributions("anchor", {
    fragments: [{ id: "anchor", resolve: () => ({ kind: "resolved", originLine: 1 }) }],
  });
  const result = await fixture.read.execute(
    { path: `${source}#line`, views: ["jq:.hidden"] },
    { cwd: process.cwd() },
  );
  expect(result.isError).toBe(true);
  expect(result.details.failure).toMatchObject({ code: "UNSUPPORTED_RANGE", pluginId });
  expect(fixture.input).not.toHaveBeenCalled();
});

test("an owned semantic field fragment is a whole JSON source", async () => {
  const fixture = provider();
  const result = await fixture.read.execute(
    { path: `${source}#fields`, views: ["jq:.id"] },
    { cwd: process.cwd() },
  );
  expect(JSON.parse(canonical(result))).toBe("selected");
});

test("complete jq output remains available after automatic preview truncation", async () => {
  const fixture = provider();
  const rows = DEFAULT_MAX_LINES + 20;
  const result = await fixture.read.execute(
    { path: source, views: [`jq:range(0;${rows})`] },
    { cwd: process.cwd() },
  );
  expect(result.details.truncation?.truncated).toBe(true);
  expect(result.details.temporarySource).toBeTypeOf("string");
  const full = await fixture.read.execute(
    { path: result.details.temporarySource },
    { cwd: process.cwd() },
    "script",
  );
  expect(canonical(full).trimEnd().split("\n").map(Number)).toEqual(
    Array.from({ length: rows }, (_, index) => index),
  );
});

test("provider failures retain their owning safe code", async () => {
  const fixture = provider();
  fixture.input.mockImplementation(() => {
    throw new ResourceError("PROVIDER_FAILED", source, "not-applied");
  });
  const result = await fixture.read.execute(
    { path: source, views: ["jq:."] },
    { cwd: process.cwd() },
  );
  expect(result.isError).toBe(true);
  expect(result.details.failure?.cause).toBeInstanceOf(ResourceError);
  expect(result.details.failure?.cause).toMatchObject({ code: "PROVIDER_FAILED" });
});

test("cancellation and malformed JSON never return an unfiltered success", async () => {
  const fixture = provider();
  const controller = new AbortController();
  controller.abort();
  const cancelled = await fixture.read.execute(
    { path: source, views: ["jq:."] },
    { cwd: process.cwd(), signal: controller.signal },
  );
  expect(cancelled.isError).toBe(true);
  fixture.input.mockReturnValue("not JSON");
  const invalid = await fixture.read.execute(
    { path: source, views: ["jq:."] },
    { cwd: process.cwd() },
  );
  expect(invalid.isError).toBe(true);
  expect(invalid.details.failure?.code).toBe("READ_FAILED");
  expect(invalid.script).toBeUndefined();
});

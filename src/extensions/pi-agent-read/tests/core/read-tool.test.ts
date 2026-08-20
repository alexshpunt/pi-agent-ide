import { requiredValue } from "../../../../utils/required-value.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type { ResourceResolver } from "pi-agent-resource";
import type { TextLinePresenter } from "pi-agent-text";
import { expect, test } from "vitest";

import { createReadTool, type ReadTool } from "#src/core/tools/tool-read.js";

test("reads a validated resource and projects custom content", async () => {
  const read = createReadTool();
  const resolver = {
    id: "fixture",
    async tryResolve(source) {
      return {
        kind: "resolved",
        resource: {
          source: `canonical:${source}`,
          async read() {
            return [
              { type: "text", text: "chart:" },
              { type: "custom", kind: "chart", data: { values: [1, 2, 3] } },
            ];
          },
        },
      };
    },
  } satisfies ResourceResolver;

  read.registerContributions("fixture-plugin", { resolvers: [{ resolver }] });
  const result = await executeRead(read, "report");

  expect(result.content).toEqual([
    { type: "text", text: "chart:" },
    { type: "text", text: "[unsupported_content_block kind=chart index=1]" },
  ]);
  expect(result.details).toEqual({
    source: "canonical:report",
    resolvedBy: "fixture",
    unsupportedContentBlocks: [{ index: 1, kind: "chart" }],
  });
});

test("routes a restored result through its resolver renderer", async () => {
  const read = createReadTool();
  const rendererComponent = {
    render(): string[] {
      return ["rendered fixture"];
    },
    invalidate(): void {},
  };
  read.registerContributions("fixture-plugin", {
    resolvers: [
      {
        resolver: textResolver("alpha"),
        renderResult: () => rendererComponent,
      },
    ],
  });
  const result = structuredClone(await executeRead(read, "notes.txt"));

  expect(result.details.resolvedBy).toBe("fixture-text");
  const rendered = requiredValue(read.tool.renderResult)(
    result,
    { expanded: false, isPartial: false },
    {} as never,
    {} as never,
  );
  expect(rendered.render(80)).toEqual(["rendered fixture"]);
});

test("treats malformed resolver output as terminal", async () => {
  const read = createReadTool();
  let fallbackCalls = 0;
  const malformed = {
    id: "malformed",
    async tryResolve() {
      return undefined as never;
    },
  } satisfies ResourceResolver;
  const fallback = {
    id: "fallback",
    async tryResolve() {
      fallbackCalls += 1;
      return { kind: "not-handled" };
    },
  } satisfies ResourceResolver;

  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: malformed }, { resolver: fallback, priority: 1 }],
  });
  const result = await executeRead(read, "report");

  expect(result.details.failure).toMatchObject({
    code: "INVALID_RESOLVER_RESULT",
    resolverId: "malformed",
  });
  expect(fallbackCalls).toBe(0);
});

test("treats a missing read capability as terminal", async () => {
  const read = createReadTool();
  let fallbackCalls = 0;
  const writeOnly = {
    id: "write-only",
    async tryResolve(source) {
      return {
        kind: "resolved",
        resource: {
          source,
          async write() {},
        },
      };
    },
  } satisfies ResourceResolver;
  const fallback = {
    id: "fallback",
    async tryResolve() {
      fallbackCalls += 1;
      return { kind: "not-handled" };
    },
  } satisfies ResourceResolver;

  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: writeOnly }, { resolver: fallback, priority: 1 }],
  });
  const result = await executeRead(read, "report");

  expect(result.details.failure).toMatchObject({
    code: "UNSUPPORTED_CAPABILITY",
    resolverId: "write-only",
  });
  expect(fallbackCalls).toBe(0);
});

test("rejects invalid fulfilled read content", async () => {
  const read = createReadTool();
  const resolver = {
    id: "invalid-content",
    async tryResolve(source) {
      return {
        kind: "resolved",
        resource: {
          source,
          async read() {
            return [] as never;
          },
        },
      };
    },
  } satisfies ResourceResolver;

  read.registerContributions("fixture-plugin", { resolvers: [{ resolver }] });
  const result = await executeRead(read, "report");

  expect(result.details.failure).toMatchObject({
    code: "INVALID_RESOURCE_CONTENT",
    resolverId: "invalid-content",
  });
});

test("includes resolver and resource Error messages in read failures", async () => {
  const resolverCause = new Error("symbol: requires #<symbol-selector> after the file path.");
  const failedResolver = {
    id: "claimed-source",
    async tryResolve() {
      return { kind: "failed", error: resolverCause } as const;
    },
  } satisfies ResourceResolver;
  const resolverRead = createReadTool();
  resolverRead.registerContributions("resolver-errors", {
    resolvers: [{ resolver: failedResolver }],
  });

  const resolverResult = await executeRead(resolverRead, "symbol:file.ts");
  const resolverBlock = resolverResult.content[0];
  expect(resolverBlock?.type).toBe("text");
  if (resolverBlock?.type === "text") expect(resolverBlock.text).toContain(resolverCause.message);
  expect(resolverResult.details.failure?.cause).toBe(resolverCause);

  const resourceCause = new Error('Symbol "missing" was not found in file.ts.');
  const resourceResolver = {
    id: "symbol-resource",
    async tryResolve(source) {
      return {
        kind: "resolved",
        resource: {
          source,
          async read() {
            throw resourceCause;
          },
        },
      } as const;
    },
  } satisfies ResourceResolver;
  const resourceRead = createReadTool();
  resourceRead.registerContributions("resource-errors", {
    resolvers: [{ resolver: resourceResolver }],
  });

  const resourceResult = await executeRead(resourceRead, "symbol:file.ts#missing");
  const resourceBlock = resourceResult.content[0];
  expect(resourceBlock?.type).toBe("text");
  if (resourceBlock?.type === "text") expect(resourceBlock.text).toContain(resourceCause.message);
  expect(resourceResult.details.failure?.cause).toBe(resourceCause);
});

test("presents text before projecting the read result", async () => {
  const read = createReadTool();
  const resolver = {
    id: "filesystem",
    async tryResolve(source) {
      return {
        kind: "resolved",
        resource: {
          source,
          async read() {
            return [{ type: "text", text: "alpha" }];
          },
        },
      };
    },
  } satisfies ResourceResolver;

  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver }],
    presenters: [
      {
        presenter: {
          id: "fixture-prefix",
          present(document, context) {
            expect(context.purpose).toBe("read");
            return {
              ...document,
              lines: document.lines.map((line) => ({
                ...line,
                presentation: { prefix: "anchor|" },
              })),
            };
          },
        },
      },
    ],
  });

  const result = await executeRead(read, "notes.txt");
  expect(result.content).toEqual([{ type: "text", text: "anchor|alpha" }]);
});

test("runs text presenters in parallel and merges them in priority order", async () => {
  const read = createReadTool();
  const resolver = {
    id: "filesystem",
    async tryResolve(source) {
      return {
        kind: "resolved",
        resource: {
          source,
          async read() {
            return [{ type: "text", text: "alpha" }];
          },
        },
      };
    },
  } satisfies ResourceResolver;
  const started: string[] = [];
  let releasePresenters!: () => void;
  const presenterGate = new Promise<void>((resolve) => {
    releasePresenters = resolve;
  });
  const presenter = (id: string, prefix: string): TextLinePresenter => ({
    id,
    async present(document) {
      started.push(id);
      await presenterGate;
      return {
        ...document,
        lines: document.lines.map((line) => ({
          ...line,
          presentation: {
            ...line.presentation,
            prefix: `${line.presentation?.prefix ?? ""}${prefix}`,
          },
        })),
      };
    },
  });

  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver }],
    presenters: [
      { priority: 10, presenter: presenter("later", "B") },
      { priority: -1, presenter: presenter("first", "A") },
    ],
  });
  const resultReady = executeRead(read, "notes.txt");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const startedTogether = [...started];
  releasePresenters();
  const result = await resultReady;

  expect(startedTogether).toEqual(["first", "later"]);
  expect(result.content).toEqual([{ type: "text", text: "ABalpha" }]);
});

test("truncates large text at Pi's line and byte limits and tells the agent how to continue", async () => {
  const lineLimited = Array.from(
    { length: DEFAULT_MAX_LINES + 1 },
    (_, index) => `line ${index + 1}`,
  );
  const lineRead = createReadTool();
  lineRead.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: textResolver(lineLimited.join("\n")) }],
  });

  const lineResult = await executeRead(lineRead, "large-lines.txt");
  expect(lineResult.content).toEqual([
    {
      type: "text",
      text: `${lineLimited.slice(0, DEFAULT_MAX_LINES).join("\n")}\n\n[Showing lines 1-${DEFAULT_MAX_LINES} of ${
        DEFAULT_MAX_LINES + 1
      }. Use offset=${DEFAULT_MAX_LINES + 1} to continue.]`,
    },
  ]);
  expect(lineResult.details.truncation).toMatchObject({
    truncated: true,
    truncatedBy: "lines",
    outputLines: DEFAULT_MAX_LINES,
    totalLines: DEFAULT_MAX_LINES + 1,
  });
  expect(lineResult.details.lines).toHaveLength(DEFAULT_MAX_LINES);

  const byteLimited = ["a".repeat(30 * 1024), "b".repeat(30 * 1024), "tail"];
  const byteRead = createReadTool();
  byteRead.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: textResolver(byteLimited.join("\n")) }],
  });

  const byteResult = await executeRead(byteRead, "large-bytes.txt");
  expect(byteResult.content).toEqual([
    {
      type: "text",
      text: `${byteLimited[0]}\n\n[Showing lines 1-1 of 3 (${
        DEFAULT_MAX_BYTES / 1024
      }.0KB limit). Use offset=2 to continue.]`,
    },
  ]);
  expect(byteResult.details.truncation).toMatchObject({
    truncated: true,
    truncatedBy: "bytes",
    outputLines: 1,
    totalLines: 3,
  });
  expect(byteResult.details.lines).toHaveLength(1);
});

test("saves opt-in truncated output and reads the temporary protocol without presenting it again", async () => {
  const sourceLines = Array.from(
    { length: DEFAULT_MAX_LINES + 1 },
    (_, index) => `line ${index + 1}`,
  );
  const read = createReadTool();
  let presenterCalls = 0;
  let preReadCalls = 0;
  read.registerContributions("dynamic-plugin", {
    resolvers: [
      {
        resolver: textResolver(sourceLines.join("\n")),
        preserveTruncatedOutput: true,
      },
    ],
    handlers: [
      {
        stage: "pre-read",
        handler(context) {
          preReadCalls += 1;
          return { kind: "continue", context };
        },
      },
    ],
    presenters: [
      {
        presenter: {
          id: "final-prefix",
          present(document) {
            presenterCalls += 1;
            return {
              ...document,
              lines: document.lines.map((line) => ({
                ...line,
                presentation: { prefix: "final|" },
              })),
            };
          },
        },
      },
    ],
  });

  try {
    const first = await executeRead(read, "dynamic:report");
    const temporarySource = first.details.temporarySource;
    expect(temporarySource).toMatch(/^temp:[0-9a-f-]+$/u);

    if (temporarySource === undefined) {
      throw new Error("Temporary source was not returned");
    }
    const firstBlock = first.content[0];
    expect(firstBlock?.type).toBe("text");
    if (firstBlock?.type === "text") {
      expect(firstBlock.text).toContain(`Full output: ${temporarySource}`);
    }

    const remainder = await read.tool.execute(
      "temp-read",
      { path: temporarySource, offset: DEFAULT_MAX_LINES + 1 },
      undefined,
      undefined,
      { cwd: "/workspace" } as never,
    );

    expect(remainder.content).toEqual([
      { type: "text", text: `final|line ${DEFAULT_MAX_LINES + 1}` },
    ]);
    expect(remainder.details).toMatchObject({ source: temporarySource, resolvedBy: "temp" });
    expect(presenterCalls).toBe(1);
    expect(preReadCalls).toBe(1);
  } finally {
    await read.dispose();
  }
});

test("does not save an explicit range as a temporary resource", async () => {
  const read = createReadTool();
  read.registerContributions("dynamic-plugin", {
    resolvers: [{ resolver: textResolver("alpha\nbravo\ncharlie"), preserveTruncatedOutput: true }],
  });

  try {
    const result = await read.tool.execute(
      "range-read",
      { path: "dynamic:report", limit: 2 },
      undefined,
      undefined,
      { cwd: "/workspace" } as never,
    );

    expect(result.details.temporarySource).toBeUndefined();
    const resultBlock = result.content[0];
    expect(resultBlock?.type).toBe("text");
    if (resultBlock?.type === "text") expect(resultBlock.text).not.toContain("temp:");
  } finally {
    await read.dispose();
  }
});

test("does not return a partial line when the first line exceeds the byte limit", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: textResolver("x".repeat(DEFAULT_MAX_BYTES + 1)) }],
  });

  const result = await executeRead(read, "single-line.txt");

  expect(result.content).toEqual([
    {
      type: "text",
      text: "[Line 1 is 50.0KB, exceeds 50.0KB limit. Use a source-specific tool to read this line in smaller byte ranges.]",
    },
  ]);
  expect(result.details.truncation).toMatchObject({
    truncated: true,
    truncatedBy: "bytes",
    outputLines: 0,
    firstLineExceedsLimit: true,
  });
  expect(result.details.lines).toEqual([]);
});

test("reports unread source lines when an explicit limit stops early", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: textResolver("alpha\nbravo\ncharlie") }],
  });

  const result = await read.tool.execute(
    "call",
    { path: "notes.txt", limit: 2 },
    undefined,
    undefined,
    { cwd: "/workspace" } as never,
  );

  expect(result.content).toEqual([
    {
      type: "text",
      text: "alpha\nbravo\n\n[1 more lines in source. Use offset=3 to continue.]",
    },
  ]);
  expect(result.details.truncation).toBeUndefined();
});

test("rejects a malformed resolver registration", () => {
  const read = createReadTool();

  expect(() => {
    read.registerContributions("fixture-plugin", {
      resolvers: [{ resolver: { id: "broken" } as never }],
    });
  }).toThrow(/invalid resource resolver/u);
});

function executeRead(read: ReadTool, path: string) {
  return read.tool.execute("call", { path }, undefined, undefined, { cwd: "/workspace" } as never);
}

function textResolver(content: string): ResourceResolver {
  return {
    id: "fixture-text",
    async tryResolve(source) {
      return {
        kind: "resolved",
        resource: {
          source,
          async read() {
            return [{ type: "text", text: content }];
          },
        },
      };
    },
  };
}

import type { ResourceResolver } from "pi-agent-resource";
import { expect, test } from "vitest";

import { createReadTool, type ReadTool } from "#src/core/tools/tool-read.js";
import type { FragmentResolverRegistration } from "#src/api/tools/read.js";

const TEN_LINES = Array.from({ length: 10 }, (_, index) => `l${index + 1}`).join("\n");

test("reads a source containing # whole when a resolver handles it", async () => {
  const read = createReadTool();
  let fragmentCalls = 0;
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: textResolver("whole file") }],
    fragments: [
      fragmentResolver({
        resolve() {
          fragmentCalls += 1;
          return { kind: "resolved", originLine: 7 };
        },
      }),
    ],
  });

  const result = await executeRead(read, "notes.txt#anchor");

  expect(result.details.failure).toBeUndefined();
  expect(result.details.startLine).toBe(1);
  expect(fragmentCalls).toBe(0);
});

test("starts the window at the fragment origin with absolute numbering", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: failingTextResolver(TEN_LINES) }],
    fragments: [fragmentResolver({ originLine: 7 })],
  });

  const result = await executeRead(read, "notes.txt#l7");

  expect(result.details.failure).toBeUndefined();
  expect(result.details.source).toBe("notes.txt");
  expect(result.details.startLine).toBe(7);
  expect(result.details.endLine).toBe(10);
  expect(result.details.totalLines).toBe(10);
  expect(result.content[0]).toEqual({ type: "text", text: "l7\nl8\nl9\nl10" });
});

test("counts positive offsets from the origin", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: failingTextResolver(TEN_LINES) }],
    fragments: [fragmentResolver({ originLine: 3 })],
  });

  const result = await executeRead(read, "notes.txt#l3", { offset: 2, limit: 2 });

  expect(result.details.startLine).toBe(4);
  expect(result.details.endLine).toBe(5);
});

test("treats zero as the default anchored offset", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: failingTextResolver(TEN_LINES) }],
    fragments: [fragmentResolver({ originLine: 3 })],
  });

  const omitted = await executeRead(read, "notes.txt#l3", { limit: 1 });
  const one = await executeRead(read, "notes.txt#l3", { offset: 1, limit: 1 });
  const zero = await executeRead(read, "notes.txt#l3", { offset: 0, limit: 1 });

  expect(omitted.details.startLine).toBe(3);
  expect(one.details.startLine).toBe(3);
  expect(zero.details.startLine).toBe(3);
  expect(zero.content).toEqual(one.content);
});

test("widens the window upward with negative offsets and clamps at line one", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: failingTextResolver(TEN_LINES) }],
    fragments: [fragmentResolver({ originLine: 3 })],
  });

  const above = await executeRead(read, "notes.txt#l3", { offset: -2, limit: 4 });
  expect(above.details.startLine).toBe(1);
  expect(above.details.endLine).toBe(4);

  const clamped = await executeRead(read, "notes.txt#l3", { offset: -50, limit: 1 });
  expect(clamped.details.startLine).toBe(1);
  expect(clamped.details.endLine).toBe(1);
});

test("states continuation offsets relative to the origin", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: failingTextResolver(TEN_LINES) }],
    fragments: [fragmentResolver({ originLine: 5 })],
  });

  const result = await executeRead(read, "notes.txt#l5", { limit: 2 });

  expect(result.details.startLine).toBe(5);
  expect(result.details.endLine).toBe(6);
  expect(result.content[0]?.type).toBe("text");
  expect(result.content[0]?.type === "text" && result.content[0].text).toContain(
    "[4 more lines in source. Use offset=3 to continue.]",
  );
});

test("reports fragment failures with the resolver message", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: failingTextResolver(TEN_LINES) }],
    fragments: [
      fragmentResolver({
        resolve: () => ({
          kind: "failed",
          message: 'Anchor "missing" matches no lines',
        }),
      }),
    ],
  });

  const result = await executeRead(read, "notes.txt#missing");

  expect(result.details.failure).toBeDefined();
  expect(result.content[0]?.type === "text" && result.content[0].text).toContain(
    'Anchor "missing" matches no lines',
  );
});

test("requires a fragment resolver for anchored sources", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: failingTextResolver(TEN_LINES) }],
  });

  const result = await executeRead(read, "notes.txt#l1");

  expect(result.details.failure).toBeDefined();
  expect(result.details.failure?.code).toBe("NO_FRAGMENT_RESOLVER");
});

test("rejects anchors when every fragment resolver declines", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: failingTextResolver(TEN_LINES) }],
    fragments: [fragmentResolver({ resolution: { kind: "not-handled" } })],
  });

  const result = await executeRead(read, "notes.txt#l1");

  expect(result.details.failure).toBeDefined();
  expect(result.details.failure?.code).toBe("NO_FRAGMENT_RESOLVER");
});

test("requires textual content for anchored reads", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [
      {
        resolver: {
          id: "fixture-binary",
          tryResolve(source) {
            if (source.includes("#")) {
              return Promise.resolve({
                kind: "failed",
                error: new Error(`ENOENT: ${source}`),
              });
            }
            return Promise.resolve({
              kind: "resolved",
              resource: {
                source,
                async read() {
                  return [{ type: "custom", kind: "chart", data: {} }];
                },
              },
            });
          },
        },
      },
    ],
    fragments: [fragmentResolver({ originLine: 1 })],
  });

  const result = await executeRead(read, "chart.bin#anchor");

  expect(result.details.failure).toBeDefined();
  expect(result.details.failure?.code).toBe("UNSUPPORTED_RANGE");
  expect(result.details.failure?.message).toContain("textual content");
});

test("rejects out-of-range origins from fragment resolvers", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: failingTextResolver(TEN_LINES) }],
    fragments: [fragmentResolver({ originLine: 99 })],
  });

  const result = await executeRead(read, "notes.txt#l9");

  expect(result.details.failure).toBeDefined();
  expect(result.details.failure?.code).toBe("INVALID_RESOLVER_RESULT");
});

function executeRead(
  read: ReadTool,
  path: string,
  range?: { readonly offset?: number; readonly limit?: number },
) {
  return read.tool.execute("call", { path, ...range }, undefined, undefined, {
    cwd: "/workspace",
  } as never);
}

/** Resolves every source as one text resource. */
function textResolver(content: string): ResourceResolver {
  return {
    id: "fixture-text",
    tryResolve(source) {
      return Promise.resolve({
        kind: "resolved",
        resource: {
          source,
          async read() {
            return [{ type: "text", text: content }];
          },
        },
      });
    },
  };
}

test("keeps a resolver's read failure for a source it claimed with an anchor", async () => {
  const read = createReadTool();
  let fragmentCalls = 0;
  read.registerContributions("fixture-plugin", {
    resolvers: [
      {
        resolver: {
          id: "fixture-text",
          tryResolve(source) {
            return Promise.resolve({
              kind: "resolved",
              resource: {
                source,
                async read() {
                  throw new Error('Symbol "UserService/missing" was not found in service.ts.');
                },
              },
            });
          },
        },
      },
    ],
    fragments: [
      fragmentResolver({
        resolve() {
          fragmentCalls += 1;
          return { kind: "resolved", originLine: 1 };
        },
      }),
    ],
  });

  const result = await executeRead(read, "symbol:service.ts#UserService/missing");

  expect(result.details.failure?.code).toBe("READ_FAILED");
  const block = result.content[0];

  if (block?.type !== "text") {
    throw new Error("Expected a text block");
  }

  expect(block.text).toContain('Symbol "UserService/missing" was not found in service.ts.');
  expect(fragmentCalls).toBe(0);
});

test("retries the bare source when an anchored file read fails", async () => {
  const read = createReadTool();
  read.registerContributions("fixture-plugin", {
    resolvers: [{ resolver: missingAnchoredFileResolver(TEN_LINES) }],
    fragments: [fragmentResolver({ originLine: 3 })],
  });
  const result = await executeRead(read, "notes.txt#l3");

  expect(result.details.failure).toBeUndefined();
  expect(result.details.source).toBe("notes.txt");
  expect(result.details.startLine).toBe(3);
});

/** Simulates a filesystem resolver that opens the literal path and misses anchored names. */
function missingAnchoredFileResolver(content: string): ResourceResolver {
  return {
    id: "fixture-text",
    tryResolve(source) {
      return Promise.resolve({
        kind: "resolved",
        resource: {
          source,
          async read() {
            if (source.includes("#")) {
              throw new Error(`ENOENT: no such file or directory, open '${source}'`);
            }
            return [{ type: "text", text: content }];
          },
        },
      });
    },
  };
}

/** Fails anchored sources at the resolve stage, like a strict resolver would. */
function failingTextResolver(content = "unreachable"): ResourceResolver {
  return {
    id: "fixture-text",
    tryResolve(source) {
      if (source.includes("#")) {
        return Promise.resolve({ kind: "failed", error: new Error(`ENOENT: ${source}`) });
      }
      return Promise.resolve({
        kind: "resolved",
        resource: {
          source,
          async read() {
            return [{ type: "text", text: content }];
          },
        },
      });
    },
  };
}

interface FragmentFixture {
  readonly originLine?: number;
  readonly resolution?: { readonly kind: "not-handled" };
  readonly resolve?: (
    context: unknown,
  ) =>
    | { readonly kind: "resolved"; readonly originLine: number }
    | { readonly kind: "not-handled" }
    | { readonly kind: "failed"; readonly message: string };
}

function fragmentResolver(fixture: FragmentFixture): FragmentResolverRegistration {
  return {
    id: "fixture-fragments",
    resolve(context) {
      if (fixture.resolve !== undefined) {
        return fixture.resolve(context);
      }
      if (fixture.resolution !== undefined) {
        return fixture.resolution;
      }
      return { kind: "resolved", originLine: requiredOrigin(fixture.originLine) };
    },
  };
}

function requiredOrigin(originLine: number | undefined): number {
  if (originLine === undefined) {
    throw new Error("Fragment fixture requires originLine");
  }
  return originLine;
}

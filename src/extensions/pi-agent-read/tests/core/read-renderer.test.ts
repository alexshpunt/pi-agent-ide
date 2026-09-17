import { requiredValue } from "pi-agent-invariant";
import { type AgentToolResult, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { withTextSourceLine } from "pi-agent-text";
import { expect, test } from "vitest";

import { createReadResultRenderer } from "#src/core/tools/read/read-renderer.js";
import { createReadTool } from "#src/core/tools/tool-read.js";

import type { ReadResultDetails, ReadTextLine } from "#src/api/tools/read.js";

const plainTheme = {
  bold: (text: string): string => text,
  fg: (_color: string, text: string): string => text,
  underline: (text: string): string => text,
} as Theme;

initTheme("dark", false);

test("renders projected view content and expands the complete saved result", () => {
  const lines: ReadTextLine[] = Array.from({ length: 15 }, (_, index) => ({
    lineNumber: index + 1,
    content:
      index === 0 ? "clean line 1  <!-- scope-begin-DEAD -->" : `clean line ${String(index + 1)}`,
    lineEnding: index === 14 ? "" : "\n",
    presentation: {
      prefix: `${String(index + 1)}#HASH|`,
      suffix: " <!-- agent hint -->",
      ...({ compactPrefix: `${String(index + 1)} │ ` } as Record<string, string>),
    },
  }));
  const result: AgentToolResult<ReadResultDetails> = {
    content: [
      {
        type: "text",
        text: lines
          .map(
            (line) =>
              `${line.presentation?.prefix}${line.content}${line.presentation?.suffix}${line.lineEnding}`,
          )
          .join(""),
      },
    ],
    details: {
      source: "/workspace/notes.txt",
      resolvedBy: "example-source",
      startLine: 1,
      endLine: 15,
      totalLines: 15,
      lines,
    },
  };
  const renderer = createReadResultRenderer({ kind: "code-view" });
  const compact = renderer(result, { expanded: false, isPartial: false }, plainTheme, {
    isError: false,
    lastComponent: undefined,
  } as never);
  const compactText = compact.render(80).join("\n");

  expect(compactText).toContain("1 │ clean line 1");
  expect(compactText).not.toContain("1#HASH");
  expect(compactText).toContain("agent hint");
  expect(compactText).toContain("scope-begin");
  expect(compactText).toContain("4 more rows");
  expect(compactText).toContain("to expand");

  const expanded = renderer(result, { expanded: true, isPartial: false }, plainTheme, {
    isError: false,
    lastComponent: compact,
  } as never);
  const expandedText = expanded.render(80).join("\n");

  expect(expanded).toBe(compact);
  expect(expandedText).toContain("clean line 15");

  expect(expandedText).toContain("1#HASH|clean line 1");
  expect(expandedText).not.toContain("more rows");
});

test("code views highlight source before adding line and scope annotations", () => {
  const line = withTextSourceLine(
    {
      lineNumber: 1,
      content: "export const answer = 42;",
      lineEnding: "\n",
      presentation: {
        prefix: "7#ABCD|",
        suffix: "  <!-- scope-begin-C0DE -->",
      },
    },
    {
      source: "/workspace/example.ts",
      lineNumber: 7,
      content: "export const answer = 42;",
    },
  );
  const result: AgentToolResult<ReadResultDetails> = {
    content: [
      {
        type: "text",
        text: "7#ABCD|export const answer = 42;  <!-- scope-begin-C0DE -->\n",
      },
    ],
    details: {
      source: "ast:/workspace/example.ts",
      resolvedBy: "ast",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      lines: [line],
    },
  };
  const renderer = createReadResultRenderer({ kind: "code-view" });
  const rendered = renderer(result, { expanded: true, isPartial: false }, plainTheme, {
    isError: false,
    lastComponent: undefined,
  } as never)
    .render(100)
    .join("\n");

  expect(rendered).toContain("7#ABCD|");
  expect(rendered).toContain("scope-begin-C0DE");
  expect(rendered).toContain("\u001b[");
  expect(stripTerminalSequences(rendered)).toContain(
    "7#ABCD|export const answer = 42;  <!-- scope-begin-C0DE -->",
  );
});
test("shows read intent in one compact line and exact arguments when expanded", () => {
  const renderCall = createReadTool().tool.renderCall;

  expect(renderCall).toBeTypeOf("function");
  if (renderCall === undefined) {
    return;
  }

  const arguments_ = {
    path: "src/features/authentication/extra-long-authentication-source.ts",
    offset: 40,
    limit: 30,
    views: ["anchors"],
  };
  const compact = renderCall(arguments_, plainTheme, {
    expanded: false,
    lastComponent: undefined,
  } as never)
    .render(52)
    .map(stripTerminalSequences);

  expect(compact).toHaveLength(1);
  expect(visibleWidth(requiredValue(compact[0]))).toBeLessThanOrEqual(52);
  expect(compact[0]).toContain("read");
  expect(compact[0]).toContain("authentication-source.ts:40-69");

  const expanded = renderCall(arguments_, plainTheme, {
    expanded: true,
    lastComponent: undefined,
  } as never)
    .render(100)
    .map(stripTerminalSequences);
  const expandedText = expanded.join("\n");

  expect(expanded.every((line) => visibleWidth(line) <= 100)).toBe(true);
  expect(expandedText).toContain(
    "path=src/features/authentication/extra-long-authentication-source.ts",
  );
  expect(compact.join("\n")).toContain(":40-69");
  expect(expandedText).toContain("lines=40-69");
  expect(expandedText).not.toContain("offset=40");
  expect(expandedText).not.toContain("limit=30");
  expect(expandedText).toContain("views=anchors");
});

test("lets shell resources render their own identity instead of exposing the address", () => {
  const renderCall = createReadTool().tool.renderCall;
  if (renderCall === undefined) throw new Error("Missing read call renderer");

  const lines = renderCall({ path: "shell:abcdef123456", offset: -20, limit: 20 }, plainTheme, {
    expanded: false,
    lastComponent: undefined,
  } as never).render(80);

  expect(lines).toEqual([]);
});
test.each([
  {
    name: "an anchor window",
    arguments: { path: "notes.ts#12#ABCD", offset: 2, limit: 3 },
    compact: "relative lines 2-4",
    expanded: "relative lines=2-4",
  },
  {
    name: "a search selection window",
    arguments: { path: "SEARCH#ABCD:1:line", offset: 2, limit: 3 },
    compact: "relative lines 2-4",
    expanded: "relative lines=2-4",
  },
  {
    name: "a tail window",
    arguments: { path: "notes.ts", offset: -20, limit: 5 },
    compact: "tail 20",
    expanded: "tail=20",
  },
])("renders $name without claiming an absolute range", ({ arguments: args, compact, expanded }) => {
  const renderCall = requiredValue(createReadTool().tool.renderCall);
  const compactText = renderCall(args, plainTheme, {
    expanded: false,
    lastComponent: undefined,
  } as never)
    .render(100)
    .map(stripTerminalSequences)
    .join("\n");
  const expandedText = renderCall(args, plainTheme, {
    expanded: true,
    lastComponent: undefined,
  } as never)
    .render(100)
    .map(stripTerminalSequences)
    .join("\n");

  expect(compactText).toContain(compact);
  expect(expandedText).toContain(expanded);
  expect(compactText).not.toContain(":2-4");
  if (args.offset === -20) {
    expect(compactText).toContain("limit 5");
    expect(expandedText).toContain("limit=5");
  }
});

test("syntax-highlights source content when views add prefixes and suffixes", () => {
  const line: ReadTextLine = {
    lineNumber: 1,
    content: "def total(items):",
    lineEnding: "",
    presentation: {
      prefix: "1#HASH|",
      suffix: "  ○ breakpoint",
      compactSuffix: "  ○ breakpoint",
    },
    metadata: {
      "pi-agent-text/source-line": {
        source: "/workspace/order_pipeline.py",
        lineNumber: 1,
        content: "def total(items):",
      },
    },
  };
  const result: AgentToolResult<ReadResultDetails> = {
    content: [{ type: "text", text: "1#HASH|def total(items):  ○ breakpoint" }],
    details: {
      source: "debug:abcdef/source",
      resolvedBy: "debugger-source",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      lines: [line],
    },
  };
  const rendered = createReadResultRenderer({ kind: "source" })(
    result,
    { expanded: true, isPartial: false },
    plainTheme,
    { isError: false, lastComponent: undefined } as never,
  )
    .render(100)
    .join("\n");

  expect(stripTerminalSequences(rendered)).toContain("1#HASH|def total(items):  ○ breakpoint");
  expect(rendered).toContain("\u001B[");
});
test("resolver plugins can replace only the read call header", () => {
  const read = createReadTool();
  read.registerContributions("debugger", {
    resolvers: [
      {
        resolver: {
          id: "debugger-source",
          tryResolve: () => Promise.resolve({ kind: "not-handled" as const }),
        },
        matchesCall: (source) => source.startsWith("debug:"),
        renderCall: () => ({ invalidate() {}, render: () => ["debug file · pricing.py"] }),
      },
    ],
  });
  const renderCall = requiredValue(read.tool.renderCall);
  const custom = renderCall({ path: "debug:abcdef/source" }, plainTheme, {
    lastComponent: undefined,
  } as never);
  const regular = renderCall({ path: "src/pricing.py" }, plainTheme, {
    lastComponent: undefined,
  } as never);

  expect(custom.render(80)).toEqual(["debug file · pricing.py"]);
  expect(regular.render(80).join("\n")).toContain("read");
});
test("wraps long source rows without changing the saved line", () => {
  const longLine = `const link = "${"alpha beta ".repeat(10)}https://example.com/${"x".repeat(80)}";`;
  const result: AgentToolResult<ReadResultDetails> = {
    content: [{ type: "text", text: longLine }],
    details: {
      source: "/workspace/notes.ts",
      resolvedBy: "example-source",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      lines: [{ lineNumber: 1, content: longLine, lineEnding: "" }],
    },
  };
  const renderer = createReadResultRenderer({ kind: "source" });
  const panel = renderer(result, { expanded: true, isPartial: false }, plainTheme, {
    isError: false,
    lastComponent: undefined,
  } as never);
  const rendered = panel.render(36).map(stripTerminalSequences);
  const body = rendered.slice(1, -1);

  expect(body.length).toBeGreaterThan(1);
  expect(body.every((line) => visibleWidth(line) === 36)).toBe(true);
  expect(rendered.join("\n")).toContain("https://example.com/");
  expect(rendered.join("\n")).toContain("xxx");
});

test("compact reads bound wrapped terminal rows rather than source lines", () => {
  const render = createReadResultRenderer({ kind: "source" });
  const result = { content: [{ type: "text" as const, text: "x".repeat(4000) }], details: {} };
  const context = { isError: false, lastComponent: undefined } as never;
  const compact = render(result, { expanded: false, isPartial: false }, plainTheme, context).render(
    40,
  );
  const expanded = render(result, { expanded: true, isPartial: false }, plainTheme, context).render(
    40,
  );
  expect(compact.length).toBeLessThanOrEqual(16);
  expect(expanded.length).toBeGreaterThan(100);
  expect(compact.every((row) => visibleWidth(row) <= 40)).toBe(true);
});

test("compact rendering stays responsive for a large source result", () => {
  const text = Array.from(
    { length: 11_000 },
    (_, index) => `export const value${String(index)} = ${String(index)};`,
  ).join("\n");
  const result: AgentToolResult<ReadResultDetails> = {
    content: [{ type: "text", text }],
    details: {
      source: "/workspace/large.ts",
      startLine: 1,
      endLine: 11_000,
      totalLines: 11_000,
    },
  };
  const panel = createReadResultRenderer({ kind: "source" })(
    result,
    { expanded: false, isPartial: false },
    plainTheme,
    { isError: false, lastComponent: undefined } as never,
  );

  const started = performance.now();
  const rendered = panel.render(100);
  const elapsed = performance.now() - started;

  expect(rendered.length).toBeLessThanOrEqual(16);
  expect(rendered.join("\n")).toContain("more rows");
  expect(elapsed).toBeLessThan(1_000);
});

test.each([false, true])(
  "completed clean diagnostics render no empty panel (expanded=%s)",
  (expanded) => {
    const renderer = createReadResultRenderer({ kind: "code-view" });
    const result: AgentToolResult<ReadResultDetails> = {
      content: [{ type: "text", text: "completed" }],
      details: { diagnosticCheck: { complete: true, count: 0, sources: ["typescript"] } },
    };
    const context = { isError: false, lastComponent: undefined } as never;
    expect(
      renderer(result, { expanded, isPartial: false }, plainTheme, context).render(80),
    ).toEqual([]);
    expect(
      renderer(
        {
          ...result,
          details: { diagnosticCheck: { complete: false, count: 0, sources: ["typescript"] } },
        },
        { expanded, isPartial: false },
        plainTheme,
        context,
      ).render(80).length,
    ).toBeGreaterThan(0);
  },
);

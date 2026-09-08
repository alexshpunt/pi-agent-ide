import path from "node:path";
import { homedir } from "node:os";
import {
  createReadToolDefinition,
  getReadmePath,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { requiredValue } from "pi-agent-invariant";
import { expect, test } from "vitest";
import { nativeReadArguments } from "#src/core/tools/read/native-resource-renderer.js";
import { createReadResultRenderer, renderReadCall } from "#src/core/tools/read/read-renderer.js";

initTheme("dark", false);
const theme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
  underline: (text: string) => text,
} as Theme;
const cwd = path.resolve(".agents/tmp/native-read-fixture");
const native = createReadToolDefinition(cwd);
const piRoot = path.dirname(getReadmePath());
const context = (
  args: { path: string },
  expanded = false,
  lastComponent?: Text,
): Parameters<NonNullable<typeof native.renderCall>>[2] => ({
  args,
  expanded,
  lastComponent,
  cwd,
  toolCallId: "read-test",
  invalidate() {},
  state: {},
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  showImages: false,
  isError: false,
});

test.each([
  "skills/example/SKILL.md",
  "AGENTS.md",
  "AGENTS.MD",
  "AGENTS.override.md",
  "CLAUDE.md",
  "CLAUDE.MD",
  getReadmePath(),
  path.join(piRoot, "docs/skills.md"),
  path.join(piRoot, "examples/example.ts"),
  path.relative(cwd, getReadmePath()),
  path.join(homedir(), "skills/example/SKILL.md"),
])("recognizes native resource %s", (file) => {
  expect(nativeReadArguments({ path: file }, cwd)).toBeDefined();
});

test.each([
  "notes.md",
  "README.md",
  "docs/skills.md",
  "skill.md",
  "AGENTS.md.txt",
  path.join(piRoot + "-other", "docs/skills.md"),
  path.join(piRoot, "src/example.ts"),
  "https://example.org/SKILL.md",
  "temp:SKILL.md",
  "ast:AGENTS.md",
  "skills/example/SKILL.md#heading",
])("leaves other sources with the IDE renderer: %s", (file) => {
  expect(nativeReadArguments({ path: file }, cwd)).toBeUndefined();
});

test.each([{ views: ["anchors"] }, { views: ["lines"] }, { offset: -3 }, { offset: 0 }])(
  "keeps IDE-only selection semantics: %j",
  (options) => {
    expect(
      nativeReadArguments({ path: "skills/example/SKILL.md", ...options }, cwd),
    ).toBeUndefined();
  },
);

test.each(["skills/example/SKILL.md", "AGENTS.md", getReadmePath()])(
  "delegates native call presentation in both modes: %s",
  (file) => {
    const args = { path: file, offset: 2, limit: 3 };
    for (const expanded of [false, true]) {
      const actual = renderReadCall(args, theme, context(args, expanded));
      const expected = requiredValue(native.renderCall)(args, theme, context(args, expanded));
      for (const width of [8, 24, 80]) {
        expect(actual.render(width)).toEqual(expected.render(width));
        expect(actual.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
  },
);

test("native results collapse, expand and reuse components without changing model data", () => {
  const renderer = createReadResultRenderer({ kind: "source", nativeResources: true });
  const args = { path: "skills/example/SKILL.md" };
  const result = {
    content: [{ type: "text" as const, text: "# Fixture\n\nA saved instruction." }],
    details: { source: args.path },
  };
  const saved = JSON.stringify(result);
  const collapsed = renderer(result, { expanded: false, isPartial: false }, theme, context(args));
  expect(collapsed.render(80)).toEqual([]);
  const expanded = renderer(
    result,
    { expanded: true, isPartial: false },
    theme,
    context(args, true, collapsed as Text),
  );
  const expected = requiredValue(native.renderResult)(
    { ...result, details: {} },
    { expanded: true, isPartial: false },
    theme,
    context(args, true),
  );
  expect(expanded.render(80)).toEqual(expected.render(80));
  expect(JSON.stringify(result)).toBe(saved);
  const failed = renderer(result, { expanded: false, isPartial: false }, theme, {
    ...context(args),
    isError: true,
  });
  expect(failed.render(80).length).toBeGreaterThan(0);
});

test("other source renderers keep their content cards unless they opt in", () => {
  const args = { path: "skills/example/SKILL.md" };
  const result = { content: [{ type: "text" as const, text: "saved data" }], details: {} };
  const panel = createReadResultRenderer({ kind: "source" })(
    result,
    { expanded: false, isPartial: false },
    theme,
    context(args),
  );
  expect(panel.render(80).length).toBeGreaterThan(1);
});

test("view changes safely replace native and IDE components in both slots", () => {
  const args = { path: "skills/example/SKILL.md" };
  const viewed = { ...args, views: ["lines"] };
  const header = renderReadCall(viewed, theme, context(viewed));
  const nativeHeader = renderReadCall(args, theme, { ...context(args), lastComponent: header });
  expect(nativeHeader).toBeInstanceOf(Text);
  expect(
    renderReadCall(viewed, theme, { ...context(viewed), lastComponent: nativeHeader }),
  ).not.toBe(nativeHeader);
  const renderer = createReadResultRenderer({ kind: "source", nativeResources: true });
  const result = { content: [{ type: "text" as const, text: "fixture line" }], details: {} };
  const panel = renderer(result, { expanded: false, isPartial: false }, theme, context(viewed));
  expect(panel.render(80).length).toBeGreaterThan(1);
  const nativeResult = renderer(result, { expanded: false, isPartial: false }, theme, {
    ...context(args),
    lastComponent: panel,
  });
  expect(nativeResult.render(80)).toEqual([]);
  expect(
    renderer(result, { expanded: false, isPartial: false }, theme, {
      ...context(viewed),
      lastComponent: nativeResult,
    }).render(80),
  ).toEqual(panel.render(80));
});

import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { registerCodemodeRendering } from "./codemode-rendering.js";

function setup(compact = true) {
  let resolve: Parameters<ExtensionAPI["registerToolRenderer"]>[0] | undefined;
  registerCodemodeRendering(
    {
      registerToolRenderer: (renderer) => {
        resolve = renderer;
      },
    },
    compact,
  );
  const renderCall = vi.fn<NonNullable<ToolRenderers["renderCall"]>>(() => new Text("call", 0, 0));
  const renderResult = vi.fn<NonNullable<ToolRenderers["renderResult"]>>(
    () => new Text("result", 0, 0),
  );
  const original: ToolRenderers = { renderCall, renderResult };
  const renderer = resolve?.("codemode", () => original);
  if (!renderer) throw new Error("Missing renderer");
  return { resolve, renderer, original, renderCall, renderResult };
}

const context = { expanded: false, isError: false } as Parameters<
  NonNullable<ToolRenderers["renderCall"]>
>[2];
const theme = {} as Parameters<NonNullable<ToolRenderers["renderCall"]>>[1];

// The wrapper must affect only the display inputs, not execution or retained results.
test("compact rendering delegates native summaries without script or successful output", () => {
  const run = setup();
  const args = { code: "text('large output')" };
  const result = {
    content: [{ type: "text" as const, text: "large output" }],
    details: { calls: [{ name: "read", status: "ok" }] },
  };
  const options = { expanded: false, isPartial: false };
  run.renderer.renderCall?.(args, theme, context);
  run.renderer.renderResult?.(result, options, theme, context);
  expect(run.renderCall).toHaveBeenCalledWith({ code: "" }, theme, context);
  expect(run.renderResult).toHaveBeenCalledWith(
    { ...result, content: [] },
    options,
    theme,
    context,
  );
  expect(args.code).toBe("text('large output')");
  expect(result.content[0]?.text).toBe("large output");
  expect(run.renderResult.mock.calls[0]?.[0]?.details).toBe(result.details);
});

test("expanded, detailed and failed results keep original renderer inputs", () => {
  const result = { content: [{ type: "text" as const, text: "actionable failure" }], details: {} };
  const args = { code: "throw Error('failure')" };
  const expanded = { ...context, expanded: true };
  const run = setup();
  run.renderer.renderCall?.(args, theme, expanded);
  run.renderer.renderResult?.(result, { expanded: true, isPartial: false }, theme, expanded);
  expect(run.renderCall.mock.calls[0]?.[0]).toBe(args);
  expect(run.renderResult.mock.calls[0]?.[0]).toBe(result);
  run.renderer.renderResult?.(result, { expanded: false, isPartial: false }, theme, {
    ...context,
    isError: true,
  });
  expect(run.renderResult.mock.calls[1]?.[0]).toBe(result);
  const detailed = setup(false);
  expect(detailed.renderer).toBe(detailed.original);
});

test("other tools and unavailable native renderers are left alone", () => {
  const run = setup();
  expect(run.resolve?.("read", () => run.original)).toBe(run.original);
  expect(run.resolve?.("codemode", () => undefined)).toBeUndefined();
});

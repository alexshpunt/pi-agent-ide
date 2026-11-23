import {
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";

import {
  guardComponent,
  guardRenderer,
  isProgrammingError,
  stackMentions,
} from "pi-problem-report";

test("programming errors are told apart from expected failures", () => {
  for (const error of [
    new TypeError("t"),
    new ReferenceError("r"),
    new RangeError("r"),
    new SyntaxError("s"),
    new EvalError("e"),
    new URIError("u"),
    { name: "TypeError", message: "from another realm" },
  ])
    expect(isProgrammingError(error)).toBe(true);
  class ExpectedError extends Error {}
  for (const error of [new Error("e"), new ExpectedError("x"), "TypeError", undefined, null, {}])
    expect(isProgrammingError(error)).toBe(false);
});

test("a stack mentions a root when one of its frames lies inside it", () => {
  const error = new Error("x");
  error.stack = [
    "Error: x",
    "    at run (/opt/pkg/node_modules/sample/src/a.ts:1:1)",
    "    at file:///opt/other%20place/b.js:2:2",
  ].join("\n");
  expect(stackMentions(error, ["/opt/pkg/node_modules/sample"])).toBe(true);
  expect(stackMentions(error, ["/opt/pkg/node_modules/sample/"])).toBe(true);
  expect(stackMentions(error.stack, ["/opt/other place"])).toBe(true);
  expect(stackMentions(error, ["file:///opt/other%20place"])).toBe(true);
  expect(stackMentions(error, ["/opt/pkg/node_modules/samp"])).toBe(false);
  expect(stackMentions(error, ["/opt/pkg/node_modules/sample/src/a.ts"])).toBe(false);
  expect(stackMentions(error, [])).toBe(false);
  expect(stackMentions(undefined, ["/opt"])).toBe(false);
});

test("the first stack line, which holds the message, does not count as a frame", () => {
  expect(stackMentions("Error: failed in /opt/pkg/x.ts\n    at native", ["/opt/pkg"])).toBe(false);
});

test("frames in a root's own node_modules belong to its dependencies, not to it", () => {
  const dependency = "Error: x\n    at run (/opt/pkg/node_modules/dep/index.js:1:1)";
  expect(stackMentions(dependency, ["/opt/pkg"])).toBe(false);
  expect(stackMentions(`${dependency}\n    at call (/opt/pkg/src/a.ts:2:2)`, ["/opt/pkg"])).toBe(
    true,
  );
});

test("Windows frames match regardless of separators and drive-letter case", () => {
  const stack = "Error: x\n    at run (C:\\Users\\me\\pkg\\src\\a.ts:1:1)";
  expect(stackMentions(stack, ["c:\\users\\me\\pkg"])).toBe(true);
  expect(stackMentions(stack, ["C:/Users/me/pkg"])).toBe(true);
  expect(stackMentions(stack, ["C:/Users/me/other"])).toBe(false);
});

class Sample implements Component {
  failing = true;
  render(_width: number): string[] {
    if (this.failing) throw new TypeError("render failed");
    return ["fine"];
  }
  handleInput(_data: string): void {
    throw new RangeError("input failed");
  }
  handleMouse(_event: TuiMouseEvent): TuiMouseEventResult | undefined {
    throw new RangeError("mouse failed");
  }
  invalidate(): void {}
}

const mouse: TuiMouseEvent = {
  type: "press",
  button: "left",
  x: 0,
  y: 0,
  screenX: 0,
  screenY: 0,
  width: 10,
  height: 1,
  shift: false,
  alt: false,
  ctrl: false,
};

test("a guarded component keeps its identity, reports its first error and draws a notice", () => {
  const onError = vi.fn();
  const component = new Sample();
  const guarded = guardComponent(component, onError);
  expect(guarded).toBe(component);
  expect(guarded).toBeInstanceOf(Sample);
  const lines = guarded.render(20);
  expect(lines).toHaveLength(1);
  expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(20);
  expect(() => guarded.render(0)).not.toThrow();
  expect(() => guarded.handleInput("x")).not.toThrow();
  expect(guarded.handleMouse(mouse)).toEqual({ handled: true });
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(TypeError);
  component.failing = false;
  expect(guarded.render(20)).toEqual(["fine"]);
});

test("guarding twice changes nothing and does not add missing handlers", () => {
  const onError = vi.fn();
  const component: Component = {
    render: () => {
      throw new Error("x");
    },
    invalidate: () => {},
  };
  guardComponent(component, onError);
  const render = component.render;
  expect(guardComponent(component, vi.fn())).toBe(component);
  expect(component.render).toBe(render);
  expect(component.handleInput).toBeUndefined();
  expect(component.handleMouse).toBeUndefined();
  component.render(10);
  expect(onError).toHaveBeenCalledTimes(1);
});

test("a throwing error callback does not escape", () => {
  const guarded = guardComponent(new Sample(), () => {
    throw new Error("reporter broken");
  });
  expect(() => guarded.render(10)).not.toThrow();
});

test("a guarded renderer guards what it returns and leaves its own exceptions to Pi", () => {
  const onError = vi.fn();
  const component = new Sample();
  const render = guardRenderer((value: number) => (value > 0 ? component : undefined), onError);
  expect(render(1)).toBe(component);
  expect(render(0)).toBeUndefined();
  component.render(10);
  expect(onError).toHaveBeenCalledTimes(1);
  const failing = guardRenderer(() => {
    throw new Error("factory failed");
  }, onError);
  expect(() => failing()).toThrow("factory failed");
});

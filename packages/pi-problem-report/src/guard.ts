import { fileURLToPath } from "node:url";

import { truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

import { errorMessage } from "./report.ts";

const PROGRAMMING_ERRORS = [
  TypeError,
  ReferenceError,
  RangeError,
  SyntaxError,
  EvalError,
  URIError,
];
const PROGRAMMING_ERROR_NAMES = new Set(PROGRAMMING_ERRORS.map((type) => type.name));

/**
 * A defect in the code rather than an expected failure such as a missing file or invalid input.
 * Errors from another realm are recognized by name.
 */
export function isProgrammingError(error: unknown): boolean {
  if (PROGRAMMING_ERRORS.some((type) => error instanceof type)) return true;
  if (typeof error !== "object" || error === null || !("name" in error)) return false;
  return typeof error.name === "string" && PROGRAMMING_ERROR_NAMES.has(error.name);
}

function stackOf(errorOrStack: unknown): string | undefined {
  if (typeof errorOrStack === "string") return errorOrStack;
  if (typeof errorOrStack !== "object" || errorOrStack === null || !("stack" in errorOrStack))
    return undefined;
  return typeof errorOrStack.stack === "string" ? errorOrStack.stack : undefined;
}

function normalizePath(value: string): string {
  let path = value;
  if (path.startsWith("file:")) {
    try {
      path = fileURLToPath(path);
    } catch {
      // Keep the value as given.
    }
  }
  return path.replaceAll("\\", "/").replace(/\/+$/u, "");
}

/**
 * Whether a stack frame lies inside one of the roots. Accepts an error or its stack text, and
 * matches frames given as paths or file URLs, with Windows separators and drive letters in any case.
 */
export function stackMentions(errorOrStack: unknown, roots: readonly string[]): boolean {
  const stack = stackOf(errorOrStack);
  if (!stack) return false;
  const frames = stack
    .split("\n")
    .slice(1)
    .filter((line) => /^\s+at\s/u.test(line))
    .map((line) => {
      try {
        return decodeURI(line);
      } catch {
        return line;
      }
    })
    .join("\n")
    .replaceAll("\\", "/");
  return roots.some((root) => {
    const target = normalizePath(root);
    if (!target) return false;
    const caseInsensitive = /^[a-z]:\//iu.test(target);
    const haystack = caseInsensitive ? frames.toLowerCase() : frames;
    const needle = `${caseInsensitive ? target.toLowerCase() : target}/`;
    // The extension's own dependencies, or a checkout's copy of Pi, are not its code.
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1))
      if (!haystack.startsWith("node_modules/", at + needle.length)) return true;
    return false;
  });
}

const GUARDED = Symbol.for("pi-problem-report.guarded-component");

function report(onError: (error: unknown) => void, error: unknown): void {
  try {
    onError(error);
  } catch {
    // Reporting a problem must never cause another one.
  }
}

/**
 * Keep a component's errors away from Pi's render loop, where an exception ends the process.
 * The component keeps its identity: its own methods are replaced in place, so Pi can pass it back
 * to a renderer as `lastComponent`. Guarding a component twice changes nothing.
 *
 * A failed render reports the error once and draws a one-line notice; later frames try the
 * original render again. Errors from keyboard and mouse handlers are reported and swallowed.
 */
export function guardComponent<T extends Component>(
  component: T,
  onError: (error: unknown) => void,
): T {
  const target: Component & { [GUARDED]?: true } = component;
  if (target[GUARDED]) return component;
  Object.defineProperty(target, GUARDED, { value: true });
  let reported = false;
  const once = (error: unknown): void => {
    if (reported) return;
    reported = true;
    report(onError, error);
  };
  const render = target.render;
  target.render = (width: number): string[] => {
    try {
      return render.call(target, width);
    } catch (error) {
      once(error);
      const message = errorMessage(error).split("\n")[0] ?? "";
      return [truncateToWidth(`⚠ This view failed to render: ${message}`, Math.max(0, width), "…")];
    }
  };
  const handleInput = target.handleInput;
  if (handleInput) {
    target.handleInput = (data: string): void => {
      try {
        handleInput.call(target, data);
      } catch (error) {
        once(error);
      }
    };
  }
  const handleMouse = target.handleMouse;
  if (handleMouse) {
    target.handleMouse = (event: TuiMouseEvent) => {
      try {
        return handleMouse.call(target, event);
      } catch (error) {
        once(error);
        return { handled: true };
      }
    };
  }
  return component;
}

/**
 * Guard every component a renderer returns. An exception from the renderer itself is rethrown:
 * Pi already catches it and falls back to its default view.
 */
export function guardRenderer<A extends unknown[], C extends Component | undefined>(
  factory: (...args: A) => C,
  onError: (error: unknown) => void,
): (...args: A) => C {
  return (...args: A) => {
    const component = factory(...args);
    return component === undefined ? component : guardComponent(component, onError);
  };
}

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";

import {
  problemReport,
  ProblemReporter,
  type Problem,
  type ProblemReporterOptions,
  type ProblemSource,
  type ProblemUi,
} from "pi-problem-report";

const source: ProblemSource = {
  name: "sample-extension",
  version: "1.2.3",
  issuesUrl: "https://github.com/example/sample-extension/issues",
};

type Widget = ((tui: TUI, theme: Theme) => Component) | undefined;
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const click = (type: TuiMouseEvent["type"], x: number, y: number): TuiMouseEvent => ({
  type,
  button: "left",
  x,
  y,
  screenX: x,
  screenY: y,
  width: 100,
  height: 6,
  shift: false,
  alt: false,
  ctrl: false,
});

const OPEN = "[Open issue]";
const COPY = "[Copy report]";
const DISABLE = "[Don't show again]";
const CLOSE = "[Close]";

function fixture(options: Omit<ProblemReporterOptions, "copy"> = {}) {
  let widget: Widget;
  const setWidget = vi.fn((_key: string, content: Widget) => {
    widget = content;
  });
  const notify = vi.fn();
  const ui: ProblemUi = { setWidget, notify };
  const copy = vi.fn(async (_text: string) => {});
  const problems = new ProblemReporter(source, { ...options, copy });
  const openUrl = vi.fn();
  // The reporter only looks for the alternate-screen `openUrl`, which TUI does not declare.
  const tui = Object.assign(Object.create(null) as TUI, { openUrl });
  const panel = (): Component | undefined => widget?.(tui, theme);
  const text = (): string => panel()?.render(100).map(stripTerminalSequences).join("\n") ?? "";
  /** Press and release on a button label, as Pi delivers a click. */
  const press = (label: string): void => {
    const component = panel();
    if (!component?.handleMouse) throw new Error("no panel");
    const lines = component.render(100).map(stripTerminalSequences);
    const row = lines.findIndex((line) => line.includes(label));
    expect(row).toBeGreaterThanOrEqual(0);
    const x = (lines[row] ?? "").indexOf(label) + 1;
    expect(component.handleMouse(click("press", x, row))).toEqual({ capture: true });
    component.handleMouse(click("click", x, row));
  };
  return { problems, ui, panel, text, press, copy, openUrl, notify, setWidget };
}

const failure = (message: string): Problem => ({ summary: "failed", error: new Error(message) });

test("the panel buttons open the prefilled issue, copy the report and close the panel", async () => {
  const { problems, ui, panel, text, press, copy, openUrl, notify } = fixture();
  problems.attach(ui);
  const problem = failure("BROKEN");
  problems.show(problem);
  expect(text()).toContain("BROKEN");
  expect(text()).not.toContain(DISABLE);
  press(OPEN);
  expect(openUrl).toHaveBeenCalledWith(problemReport(source, problem).url);
  press(COPY);
  expect(copy).toHaveBeenCalledWith(problemReport(source, problem).body);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.any(String), "info"));
  press(CLOSE);
  expect(panel()).toBeUndefined();
});

test("Open issue copies the link when the terminal cannot open URLs", async () => {
  const { problems, ui, press, copy, openUrl } = fixture();
  openUrl.mockImplementation(() => {
    throw new Error("no browser");
  });
  problems.attach(ui);
  const problem = failure("X");
  problems.show(problem);
  press(OPEN);
  await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(problemReport(source, problem).url));
});

test("a failed copy is reported as an error instead of throwing", async () => {
  const { problems, ui, press, copy, notify } = fixture();
  copy.mockRejectedValue(new Error("no clipboard"));
  problems.attach(ui);
  problems.show(failure("X"));
  press(COPY);
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.any(String), "error"));
});

test("a closed problem does not come back, while a different one does", () => {
  const { problems, ui, panel, text, press } = fixture();
  problems.attach(ui);
  problems.show(failure("FIRST"));
  press(CLOSE);
  problems.show(failure("FIRST"));
  expect(panel()).toBeUndefined();
  problems.show(failure("SECOND"));
  expect(text()).toContain("SECOND");
});

test("problems wait for a UI, show one at a time, and Close shows the next one", () => {
  const { problems, ui, text, press, panel } = fixture();
  problems.show(failure("FIRST"));
  problems.show(failure("SECOND"));
  problems.show(failure("FIRST"));
  expect(panel()).toBeUndefined();
  problems.attach(ui);
  expect(text()).toContain("FIRST");
  press(CLOSE);
  expect(text()).toContain("SECOND");
  press(CLOSE);
  expect(panel()).toBeUndefined();
});

test("a problem shown when the UI goes away is shown again in the next UI", () => {
  const first = fixture();
  first.problems.attach(first.ui);
  first.problems.show(failure("PENDING"));
  first.problems.detach();
  expect(first.panel()).toBeUndefined();
  const second = fixture();
  first.problems.attach(second.ui);
  expect(second.text()).toContain("PENDING");
});

test("with reports disabled nothing is shown, and refresh applies a changed setting", () => {
  let enabled = false;
  const { problems, ui, panel, text } = fixture({ enabled: () => enabled });
  problems.attach(ui);
  problems.show(failure("IGNORED"));
  expect(panel()).toBeUndefined();
  enabled = true;
  problems.refresh();
  expect(panel()).toBeUndefined();
  problems.show(failure("SHOWN"));
  expect(text()).toContain("SHOWN");
  enabled = false;
  problems.refresh();
  expect(panel()).toBeUndefined();
});

test("Don't show again turns reports off through the callback and clears waiting problems", async () => {
  const disable = vi.fn();
  const { problems, ui, panel, press, notify } = fixture({ disable });
  problems.attach(ui);
  problems.show(failure("FIRST"));
  problems.show(failure("SECOND"));
  press(DISABLE);
  expect(panel()).toBeUndefined();
  await vi.waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.any(String), "info"));
});

test("a failing UI never makes the reporter throw", () => {
  const problems = new ProblemReporter(source, {
    copy: async () => {},
    enabled: () => {
      throw new Error("settings broken");
    },
  });
  const ui: ProblemUi = {
    setWidget: () => {
      throw new Error("ui gone");
    },
    notify: () => {
      throw new Error("ui gone");
    },
  };
  expect(() => {
    problems.attach(ui);
    problems.show(failure("X"));
    problems.refresh();
    problems.detach();
  }).not.toThrow();
});

test("act does nothing and returns false while no problem is shown", () => {
  const { problems, ui, copy } = fixture({ disable: vi.fn() });
  for (const action of ["open", "copy", "disable", "close"] as const)
    expect(problems.act(action)).toBe(false);
  problems.show(failure("WAITING"));
  expect(problems.act("copy")).toBe(false);
  problems.attach(ui);
  problems.act("close");
  expect(problems.act("copy")).toBe(false);
  expect(copy).not.toHaveBeenCalled();
});

test("act copies the report and opens the issue in the terminal the panel was drawn for", () => {
  const { problems, ui, panel, copy, openUrl } = fixture();
  problems.attach(ui);
  const problem = failure("X");
  problems.show(problem);
  panel();
  expect(problems.act("copy")).toBe(true);
  expect(copy).toHaveBeenCalledWith(problemReport(source, problem).body);
  expect(problems.act("open")).toBe(true);
  expect(openUrl).toHaveBeenCalledWith(problemReport(source, problem).url);
  expect(panel()).toBeDefined();
});

test("act open copies the link and notifies when no terminal can open it", async () => {
  const { problems, ui, copy, notify, openUrl } = fixture();
  problems.attach(ui);
  const problem = failure("X");
  problems.show(problem);
  // The widget was never drawn, so the reporter has no terminal.
  expect(problems.act("open")).toBe(true);
  await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(problemReport(source, problem).url));
  await vi.waitFor(() => expect(notify).toHaveBeenCalledWith(expect.any(String), "info"));
  expect(openUrl).not.toHaveBeenCalled();
});

test("act close hides the problem for good and shows the next one", () => {
  const { problems, ui, text, panel } = fixture();
  problems.attach(ui);
  problems.show(failure("FIRST"));
  problems.show(failure("SECOND"));
  expect(problems.act("close")).toBe(true);
  expect(text()).toContain("SECOND");
  expect(problems.act("close")).toBe(true);
  expect(panel()).toBeUndefined();
  problems.show(failure("FIRST"));
  expect(panel()).toBeUndefined();
});

test("act disable is offered only with the option, and then turns reports off", async () => {
  const without = fixture();
  without.problems.attach(without.ui);
  without.problems.show(failure("X"));
  expect(without.problems.act("disable")).toBe(false);
  expect(without.panel()).toBeDefined();

  const disable = vi.fn();
  const { problems, ui, panel } = fixture({ disable });
  problems.attach(ui);
  problems.show(failure("FIRST"));
  problems.show(failure("SECOND"));
  expect(problems.act("disable")).toBe(true);
  expect(panel()).toBeUndefined();
  await vi.waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
});

test("with a command the panel names it, within the width, and offers off only with disable", () => {
  const lines = (options: Omit<ProblemReporterOptions, "copy">, width: number): string[] => {
    const { problems, ui, panel } = fixture(options);
    problems.attach(ui);
    problems.show(failure("X"));
    return panel()?.render(width).map(stripTerminalSequences) ?? [];
  };
  const plain = lines({}, 100);
  const withCommand = lines({ command: "sample-problem" }, 100);
  expect(withCommand.length).toBe(plain.length + 1);
  const hint = withCommand.at(-1) ?? "";
  expect(hint).toContain("/sample-problem");
  expect(hint).not.toContain("off");
  expect(lines({ command: "sample-problem", disable: vi.fn() }, 100).at(-1)).toContain("off");
  const narrow = lines({ command: "sample-problem" }, 24);
  expect(narrow.join("\n")).toContain("/sample-problem");
  for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
});

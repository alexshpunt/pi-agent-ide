import type { ClassifierApi, ClassifierModel, ClassifierResult } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import { createCodeReview, type ReviewRuntime, type ReviewNotice } from "./reviewer.js";

const jev: ClassifierModel<ClassifierApi> = {
  type: "classifier",
  provider: "typesafe",
  id: "jev-latest",
  name: "Jev",
  api: "typesafe",
  baseUrl: "https://example.test",
  input: ["text"],
  contextWindow: 32768,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const result: ClassifierResult = {
  api: "typesafe",
  provider: "typesafe",
  model: "jev-latest",
  timestamp: 0,
  stopReason: "stop",
  answers: {
    "hidden-errors": {
      type: "choice",
      choice: "violation",
      confidence: 0.95,
      probabilities: { violation: 0.95, clear: 0.03, unknown: 0.02 },
    },
  },
};
const edit = {
  file: "/project/file.ts",
  cwd: "/project",
  before: "throw error;\n",
  after: "return null;\n",
};
const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function setup() {
  const state = { enabled: true, current: edit.after };
  const classify = vi.fn<ReviewRuntime["classify"]>(async () => result);
  const available = vi.fn(async () => [jev]);
  const rules = vi.fn(async () => [
    { id: "hidden-errors", description: "Do not hide failed operations." },
  ]);
  const report = vi.fn<(notice: ReviewNotice) => void>();
  const review = createCodeReview(
    {
      enabled: () => state.enabled,
      runtime: () => ({ available, classify }),
      rules,
      current: async () => state.current,
      report,
    },
    0,
  );
  disposers.push(() => review.dispose());
  return { review, state, classify, available, rules, report };
}

test("reports the rule and exactly the diff classified, never an invented explanation", async () => {
  const h = setup();
  h.review.schedule(edit);
  await vi.waitFor(() => expect(h.report).toHaveBeenCalledOnce());
  const context = h.classify.mock.calls[0]?.[1];
  expect(context?.state.file).toBe(edit.file);
  expect(context?.state.diff).toContain("+return null;");
  expect(h.report.mock.calls[0]?.[0].text).toContain("Do not hide failed operations.");
  expect(h.report.mock.calls[0]?.[0].text).toContain("95%");
  expect(h.report.mock.calls[0]?.[0].text).toContain(context?.state.diff);
});

test.each(["disabled", "disconnected", "empty"])(
  "makes no classifier call when %s",
  async (mode) => {
    const h = setup();
    if (mode === "disabled") h.state.enabled = false;
    if (mode === "disconnected") h.available.mockResolvedValue([]);
    if (mode === "empty") h.rules.mockResolvedValue([]);
    h.review.schedule(edit);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.classify).not.toHaveBeenCalled();
    expect(h.report).not.toHaveBeenCalled();
  },
);

test("discards stale results after an external write", async () => {
  const h = setup();
  let finish!: (result: ClassifierResult) => void;
  h.classify.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.review.schedule(edit);
  await vi.waitFor(() => expect(h.classify).toHaveBeenCalledOnce());
  h.state.current = "fixed externally\n";
  finish(result);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.report).not.toHaveBeenCalled();
});

test("new edits invalidate old results, even when the new edit restores identical content", async () => {
  const h = setup();
  let finish!: (result: ClassifierResult) => void;
  h.classify.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.review.schedule(edit);
  await vi.waitFor(() => expect(h.classify).toHaveBeenCalledOnce());
  h.review.schedule({ ...edit, before: edit.after });
  finish(result);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.report).not.toHaveBeenCalled();
});

test("reports classifier failure without claiming a clean check", async () => {
  const h = setup();
  h.classify.mockResolvedValue({
    ...result,
    stopReason: "error",
    errorMessage: "Provider unavailable",
    answers: {},
  });
  h.review.schedule(edit);
  await vi.waitFor(() => expect(h.report).toHaveBeenCalledOnce());
  expect(h.report.mock.calls[0]?.[0].kind).toBe("unavailable");
  expect(h.report.mock.calls[0]?.[0].text).toContain("Provider unavailable");
});

test("does not turn insufficient context or weak scores into defects", async () => {
  const h = setup();
  h.classify.mockResolvedValue({
    ...result,
    answers: {
      "hidden-errors": {
        type: "choice",
        choice: "unknown",
        confidence: 0.8,
        probabilities: { unknown: 0.8, violation: 0.2, clear: 0 },
      },
    },
  });
  h.review.schedule(edit);
  await vi.waitFor(() => expect(h.report).toHaveBeenCalledOnce());
  expect(h.report.mock.calls[0]?.[0]).toMatchObject({ kind: "incomplete" });
});

test("shutdown cancels pending work and prevents late delivery", async () => {
  const h = setup();
  let finish!: (result: ClassifierResult) => void;
  h.classify.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  h.review.schedule(edit);
  await vi.waitFor(() => expect(h.classify).toHaveBeenCalledOnce());
  h.review.dispose();
  finish(result);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(h.report).not.toHaveBeenCalled();
});

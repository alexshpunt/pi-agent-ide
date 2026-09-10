import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { ApplyResults } from "#src/core/apply/results.js";
import { renderApplyOutput } from "#src/core/apply/output.js";

test("small native results stay inline without creating a temporary resource", async () => {
  const results = new ApplyResults();
  const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
  results.record("read-1", "read", { content: [image] });
  const output = await renderApplyOutput(results, {
    async saveTemporary() {
      throw new Error("Unexpected overflow");
    },
  });
  expect(output.level).toBe("full");
  expect(output.content).toContainEqual(image);
});

test("overflow returns a bounded summary and preserves complete output", async () => {
  const results = new ApplyResults();
  const text = "row\n".repeat(DEFAULT_MAX_LINES + 10);
  results.record("read-1", "read", { content: [{ type: "text", text }] });
  let saved = "";
  const output = await renderApplyOutput(results, {
    async saveTemporary(value) {
      saved = value;
      return "temp:fixture";
    },
  });
  expect(output.level).toBe("summary");
  expect(output.temporarySource).toBe("temp:fixture");
  expect(saved).toContain(text);
  const shown = output.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
  expect(shown.split("\n").length).toBeLessThanOrEqual(DEFAULT_MAX_LINES);
});

test("explicit mutation receipts do not repeat intermediate file snapshots", async () => {
  const results = new ApplyResults();
  results.record("edit", "mutation", {
    operation: "replace",
    ok: true,
    effect: "applied",
    files: [
      {
        source: "a.txt",
        before: "old",
        after: "transient-value",
        changes: [],
        formatting: { status: "unchanged" },
        action: "edited",
      },
    ],
    completed: ["a.txt"],
    errors: [],
  });
  results.addOperation("edit");
  results.updateFile("a.txt", "old", "final");
  const output = await renderApplyOutput(results, {
    async saveTemporary() {
      throw new Error("Unexpected overflow");
    },
  });
  expect(
    output.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
  ).not.toContain("transient-value");
});

test("explicit native content remains native", async () => {
  const results = new ApplyResults();
  const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
  results.addValue([image]);
  const output = await renderApplyOutput(results, {
    async saveTemporary() {
      throw new Error("Unexpected overflow");
    },
  });
  expect(output.content).toContainEqual(image);
});

test("selecting a mutation explicitly keeps its structured contributions", async () => {
  const results = new ApplyResults();
  results.record("edit", "mutation", {
    operation: "replace",
    ok: true,
    effect: "applied",
    metadata: { observed: 4242 },
  });
  results.addOperation("edit");
  const output = await renderApplyOutput(results, {
    async saveTemporary() {
      throw new Error("Unexpected overflow");
    },
  });
  expect(
    output.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
  ).toContain("4242");
});

test("aggregate reads offer every resource to output reduction", async () => {
  const results = new ApplyResults();
  const resources = ["a.ts", "b.ts"].map((source) => ({
    content: [{ type: "text" as const, text: "line\n".repeat(1200) }],
    details: { source },
  }));
  results.record(
    "read",
    "read",
    {},
    { content: resources.flatMap((resource) => resource.content), details: { resources } },
  );
  const reduced: string[] = [];
  const output = await renderApplyOutput(results, {
    async saveTemporary() {
      return "temp:all";
    },
    async reduceOutput(value) {
      reduced.push(value.details.source ?? "missing");
      return {
        content: [{ type: "text", text: value.details.source ?? "" }],
        details: value.details,
      };
    },
  });
  expect(reduced).toEqual(["a.ts", "b.ts"]);
  expect(output.level).toBe("compact");
});

import { describe, expect, test } from "vitest";

import { nullableValueSchema, scriptValueOf } from "./index.ts";

/** The record a shell tool returns as structured content, as the tool_result hook wraps it. */
function shellRecord(fields: Record<string, unknown> = {}) {
  return {
    status: "success",
    data: {
      output: "hello\n",
      truncated: false,
      full_output_path: "/tmp/shell.log",
      output_ranges: [{ start: 0, end: 6 }],
      exit_code: 0,
      wall_time_seconds: 0.25,
      session: "a1b2c3d4e5f6",
      source: "shell:a1b2c3d4e5f6",
      status: "completed",
      background: false,
      cwd: "/work",
      ...fields,
    },
  };
}

const input = (outcome: unknown) => ({ shown: "shown", outcome, content: [], details: {} });

describe.each(["bash", "powershell", "remote_bash", "remote_powershell"])("%s", (tool) => {
  const value = scriptValueOf(tool);

  test("a completed command resolves to Pi's bash fields and its session", () => {
    expect(value.project(input(shellRecord()))).toEqual({
      output: "hello\n",
      truncated: false,
      full_output_path: "/tmp/shell.log",
      exit_code: 0,
      wall_time_seconds: 0.25,
      session: "shell:a1b2c3d4e5f6",
    });
  });

  test("a non-zero exit code is a value, not a failure", () => {
    const outcome = shellRecord({ status: "failed", exit_code: 7 });
    expect(value.succeeded?.(input(outcome))).toBe(true);
    expect(value.project(input(outcome))).toMatchObject({ exit_code: 7, output: "hello\n" });
  });

  test("a command that could not start fails and has no value", () => {
    const outcome = shellRecord({ status: "failed", exit_code: undefined, error: "spawn ENOENT" });
    expect(value.succeeded?.(input(outcome))).toBe(false);
    expect(value.failed).toBeUndefined();
    // A refusal before any session started has no record at all.
    expect(value.succeeded?.(input({ status: "error", data: undefined }))).toBe(false);
  });

  test("a still-running command has no exit code yet", () => {
    const projected = value.project(
      input(shellRecord({ status: "running", exit_code: undefined, background: true })),
    );
    expect(projected).toEqual({
      output: "hello\n",
      truncated: false,
      full_output_path: "/tmp/shell.log",
      wall_time_seconds: 0.25,
      session: "shell:a1b2c3d4e5f6",
    });
  });

  test("a named session is addressed by its name", () => {
    const outcome = shellRecord({ session: "dev-server", source: "shell:dev-server" });
    expect(value.project(input(outcome))).toMatchObject({ session: "shell:dev-server" });
  });

  test("a lost remote session started, so it resolves to its output", () => {
    const outcome = shellRecord({ status: "lost", exit_code: undefined, error: "closed" });
    expect(value.succeeded?.(input(outcome))).toBe(true);
    expect(value.project(input(outcome))).toMatchObject({ session: "shell:a1b2c3d4e5f6" });
  });

  test("shortened output keeps its first and last part around Pi's omission marker", () => {
    // The first range ends inside the log at a character boundary; "é" is two UTF-8 bytes.
    const outcome = shellRecord({
      output: "headétail",
      truncated: true,
      output_ranges: [
        { start: 0, end: 6 },
        { start: 106, end: 110 },
      ],
    });
    expect(value.project(input(outcome))).toMatchObject({
      output: "headé\n\n[... 100 bytes omitted ...]\n\ntail",
      truncated: true,
      full_output_path: "/tmp/shell.log",
    });
  });

  test("declares the value or null", () => {
    expect(nullableValueSchema(value).anyOf).toEqual([value.schema, { type: "null" }]);
  });
});

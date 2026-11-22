import type { ScriptValue } from "./types.ts";

/** What a script gets from a terminal command, in the shape of Pi's own `bash`. */
export type TerminalValue = {
  readonly output: string;
  readonly truncated: boolean;
  readonly full_output_path: string;
  readonly exit_code?: number;
  readonly wall_time_seconds: number;
  readonly session: string;
};

const terminalValueSchema = {
  type: "object",
  properties: {
    output: { type: "string" },
    truncated: { type: "boolean" },
    full_output_path: { type: "string" },
    exit_code: { type: "number" },
    wall_time_seconds: { type: "number" },
    session: { type: "string" },
  },
  required: ["output", "truncated", "full_output_path", "wall_time_seconds", "session"],
  additionalProperties: false,
};

/**
 * bash, powershell, remote_bash and remote_powershell resolve to their output and exit code. A
 * non-zero exit code is a value; only a command that could not start resolves to `null`. Every
 * result names its session, which stays readable after the command ends.
 */
export const terminalValue: ScriptValue = {
  schema: terminalValueSchema,
  project: ({ outcome }) => terminalOutcome(outcome) ?? null,
  // A command that started reports its exit code; one that could not start has none.
  succeeded: ({ outcome }) => {
    const data = shellRecord(outcome);
    return data !== undefined && !(data.status === "failed" && data.exit_code === undefined);
  },
};

/** The terminal record the shell tools return as structured content. */
interface ShellRecord {
  readonly output: string;
  readonly truncated: boolean;
  readonly full_output_path: string;
  readonly output_ranges: readonly { readonly start: number; readonly end: number }[];
  readonly exit_code?: number;
  readonly wall_time_seconds: number;
  readonly source: string;
  readonly status: string;
}

function terminalOutcome(outcome: unknown): TerminalValue | undefined {
  const data = shellRecord(outcome);
  if (data === undefined) return undefined;
  return {
    output: markedOutput(data),
    truncated: data.truncated,
    full_output_path: data.full_output_path,
    ...(data.exit_code === undefined ? {} : { exit_code: data.exit_code }),
    wall_time_seconds: data.wall_time_seconds,
    session: data.source,
  };
}

/** Join the first and last part of a shortened log around Pi's omission marker. */
function markedOutput({ output, output_ranges: ranges }: ShellRecord): string {
  const [head, tail] = ranges;
  if (ranges.length !== 2 || head === undefined || tail === undefined) return output;
  const bytes = Buffer.from(output, "utf8");
  const headBytes = head.end - head.start;
  const omitted = tail.start - head.end;
  return `${bytes.subarray(0, headBytes).toString("utf8")}\n\n[... ${omitted} bytes omitted ...]\n\n${bytes.subarray(headBytes).toString("utf8")}`;
}

function shellRecord(outcome: unknown): ShellRecord | undefined {
  const data = record(outcome) ? outcome.data : undefined;
  if (!record(data)) return undefined;
  const { output, truncated, full_output_path, output_ranges, exit_code } = data;
  const { wall_time_seconds, source, status } = data;
  if (
    typeof output !== "string" ||
    typeof truncated !== "boolean" ||
    typeof full_output_path !== "string" ||
    !Array.isArray(output_ranges) ||
    typeof wall_time_seconds !== "number" ||
    typeof source !== "string" ||
    typeof status !== "string" ||
    (exit_code !== undefined && typeof exit_code !== "number")
  )
    return undefined;
  const ranges = (output_ranges as unknown[]).flatMap((range) =>
    record(range) && typeof range.start === "number" && typeof range.end === "number"
      ? [{ start: range.start, end: range.end }]
      : [],
  );
  return {
    output,
    truncated,
    full_output_path,
    output_ranges: ranges,
    ...(exit_code === undefined ? {} : { exit_code }),
    wall_time_seconds,
    source,
    status,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

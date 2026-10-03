import { open } from "node:fs/promises";
import { Type } from "typebox";
import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Native shell fields plus IDE session lifecycle and exact UTF-8 log ranges. */
export const shellOutputSchema = Type.Object({
  output: Type.String({
    description:
      "ANSI-free PTY output, up to 1 MiB. Longer output joins the first and last 512 KiB without adding labels or an omission marker. See output_ranges for the gap.",
  }),
  truncated: Type.Boolean({
    description:
      "Whether output omits bytes from the retained log. This is independent of whether the process has finished.",
  }),
  full_output_path: Type.String({
    description:
      "UTF-8 log of all output received so far. Available until the shell session is deleted.",
  }),
  output_ranges: Type.Array(Type.Object({ start: Type.Integer(), end: Type.Integer() }), {
    description:
      "Zero-based, end-exclusive UTF-8 byte ranges in the log, concatenated into output.",
  }),
  exit_code: Type.Optional(Type.Number({ description: "Process exit code, only when known." })),
  wall_time_seconds: Type.Number(),
  session: Type.String({ description: "Session ID." }),
  source: Type.String({ description: "Persistent shell: source for Read, input and termination." }),
  status: Type.Union(
    ["running", "completed", "failed", "stopping", "stopped", "cancelled", "lost"].map((value) =>
      Type.Literal(value),
    ),
  ),
  background: Type.Boolean(),
  wait_reason: Type.Optional(
    Type.Union([Type.Literal("timeout"), Type.Literal("interactive"), Type.Literal("steering")]),
  ),
  completion_reason: Type.Optional(Type.Literal("timeout")),
  signal: Type.Optional(Type.Number()),
  error: Type.Optional(Type.String()),
});

/** Read a bounded point-in-time result from the existing log, not the rolling preview. */
export async function structuredShellResult(snapshot: TerminalSessionSnapshot) {
  const file = await open(snapshot.fullOutputPath, "r");
  try {
    const size = (await file.stat()).size;
    const readRange = async (start: number, length: number) => {
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const chunk = await file.read(buffer, read, length - read, start + read);
        if (chunk.bytesRead === 0)
          throw new Error("Shell output log ended before its snapshot size");
        read += chunk.bytesRead;
      }
      return buffer;
    };
    let output: string;
    let outputRanges: { start: number; end: number }[];
    const truncated = size > MAX_OUTPUT_BYTES;
    if (!truncated) {
      output = (await readRange(0, size)).toString("utf8");
      outputRanges = [{ start: 0, end: size }];
    } else {
      const half = MAX_OUTPUT_BYTES / 2;
      const head = await readRange(0, half);
      const tail = await readRange(size - half, half);
      const headText = new TextDecoder().decode(head, { stream: true });
      let tailStart = 0;
      while (tailStart < tail.length && (tail.readUInt8(tailStart) & 0xc0) === 0x80) tailStart++;
      const tailText = tail.subarray(tailStart).toString("utf8");
      output = headText + tailText;
      outputRanges = [
        { start: 0, end: Buffer.byteLength(headText) },
        { start: size - half + tailStart, end: size },
      ];
    }
    return {
      output,
      truncated,
      full_output_path: snapshot.fullOutputPath,
      output_ranges: outputRanges,
      ...(snapshot.exitCode === undefined ? {} : { exit_code: snapshot.exitCode }),
      wall_time_seconds: snapshot.elapsedMs / 1000,
      session: snapshot.id,
      source: snapshot.source,
      status: snapshot.status,
      background: snapshot.background,
      ...(snapshot.waitReason === undefined ? {} : { wait_reason: snapshot.waitReason }),
      ...(snapshot.completionReason === undefined
        ? {}
        : { completion_reason: snapshot.completionReason }),
      ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
      ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
    };
  } finally {
    await file.close();
  }
}

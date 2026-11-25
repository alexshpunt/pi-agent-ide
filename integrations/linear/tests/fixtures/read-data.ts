import type { PiIntegrationTestResult } from "pi-coding-agent-test";

/** One text line of a Read result's structured data. */
export interface ReadDataLine {
  readonly lineNumber: number;
  readonly content: string;
  readonly lineEnding: string;
  readonly anchors?: readonly string[];
}

/** The text a Read returned to scripts, with its edit target and lines. */
export interface ReadTextData {
  readonly content: string;
  readonly target?: string;
  readonly lines: readonly ReadDataLine[];
}

/**
 * Read's structured data for one successful text Read.
 *
 * The IDE gives scripts this data through the `tool_result` event's structured content and
 * removes it from the result Pi keeps, so a finalized tool execution no longer carries it.
 */
export function readTextData(result: PiIntegrationTestResult, toolCallId: string): ReadTextData {
  const entry = result.traceEvents.find(
    (value) =>
      value.type === "tool_result" &&
      (value.event as { toolCallId?: string } | undefined)?.toolCallId === toolCallId,
  );
  const structured = (entry?.event as { structuredContent?: unknown } | undefined)
    ?.structuredContent as
    | {
        status?: string;
        data?: { kind?: string; target?: string; lines?: ReadDataLine[] };
      }
    | undefined;
  const data = structured?.data;
  if (structured?.status !== "success" || data?.kind !== "text" || !Array.isArray(data.lines))
    throw new Error(`Read ${toolCallId} returned no structured text data`);
  return {
    content: data.lines.map((line) => line.content + line.lineEnding).join(""),
    ...(data.target === undefined ? {} : { target: data.target }),
    lines: data.lines,
  };
}

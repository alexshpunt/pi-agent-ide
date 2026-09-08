import { storeText, restoreText, type StoredText } from "pi-agent-text";
import type { ReadResultDetails, ReadTextLine } from "#src/api/tools/read.js";

type StoredLine = readonly [
  number,
  StoredText,
  string,
  ReadTextLine["presentation"]?,
  ReadTextLine["metadata"]?,
];
interface StoredReadDetails extends Omit<ReadResultDetails, "lines" | "truncation"> {
  readonly storedLines?: readonly StoredLine[];
  readonly truncation?: Omit<NonNullable<ReadResultDetails["truncation"]>, "content">;
  readonly truncatedText?: StoredText;
}

/** Keeps line identity and annotations while reusing the saved model-facing text. */
export function compactReadDetails(details: ReadResultDetails, text: string): StoredReadDetails {
  const { lines, truncation, ...rest } = details;
  const storedLines = lines?.map((line): StoredLine => {
    const tuple: [
      number,
      StoredText,
      string,
      ReadTextLine["presentation"]?,
      ReadTextLine["metadata"]?,
    ] = [line.lineNumber, storeText(line.content, text), line.lineEnding];
    if (line.presentation !== undefined || line.metadata !== undefined)
      tuple.push(line.presentation);
    if (line.metadata !== undefined) tuple.push(line.metadata);
    return tuple;
  });
  const { content, ...truncated } = truncation ?? {};
  return {
    ...rest,
    ...(storedLines === undefined ? {} : { storedLines }),
    ...(truncation === undefined
      ? {}
      : {
          truncation: truncated as StoredReadDetails["truncation"],
          truncatedText: storeText(content ?? "", text),
        }),
  };
}

/** Recreates renderer inputs from a session result; no source access is needed. */
export function restoreReadDetails(
  value: ReadResultDetails | StoredReadDetails,
  text: string,
): ReadResultDetails {
  const stored = value as StoredReadDetails;
  if (stored.storedLines === undefined && stored.truncatedText === undefined)
    return value as ReadResultDetails;
  const { storedLines, truncatedText, truncation, ...rest } = stored;
  return {
    ...rest,
    ...(storedLines === undefined
      ? {}
      : {
          lines: storedLines.map(([lineNumber, content, lineEnding, presentation, metadata]) => ({
            lineNumber,
            content: restoreText(content, text),
            lineEnding,
            ...(presentation == null ? {} : { presentation }),
            ...(metadata == null ? {} : { metadata }),
          })),
        }),
    ...(truncation === undefined
      ? {}
      : { truncation: { ...truncation, content: restoreText(truncatedText ?? "", text) } }),
  };
}

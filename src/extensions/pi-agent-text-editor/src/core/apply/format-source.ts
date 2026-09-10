import { format } from "oxfmt";

/** Format only the completed display copy; execution always receives the original source. */
export async function formatApplySource(source: string): Promise<string> {
  try {
    const formatted = await format("apply.js", source, { printWidth: 90 });
    return formatted.errors.length === 0 ? formatted.code.trimEnd() : source;
  } catch {
    return source;
  }
}

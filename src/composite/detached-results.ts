import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Copy each tool result's details and structured content before Pi keeps them for the rest of the
 * session.
 *
 * A short string cut from a larger one, such as a line or a match taken from a file, shares the
 * larger string's memory in V8. Pi keeps every result in the session history and the transcript,
 * so one kept line would keep its whole file in memory for every result. The copy holds only the
 * text it shows. Register after every other result handler, so the copy is final.
 */
export function registerDetachedResults(pi: Pick<ExtensionAPI, "on">): void {
  pi.on("tool_result", (event) => {
    const details = detached(event.details);
    const structuredContent = detached(event.structuredContent);
    if (details === undefined && structuredContent === undefined) return;
    return {
      ...(details !== undefined && { details: details.value }),
      ...(structuredContent !== undefined && { structuredContent: structuredContent.value }),
    };
  });
}

function detached<T>(value: T): { readonly value: T } | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return { value: structuredClone(value) };
  } catch {
    // A value that is not plain data, such as a function, stays as it is.
    return undefined;
  }
}

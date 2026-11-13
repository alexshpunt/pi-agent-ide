/** Compact confirmations for completed whole-file operations inside a script. */
export function fileReceipts(
  tool: string,
  outcome: unknown,
  details: unknown,
  display: (source: string) => string,
): string[] {
  if (!record(outcome) || outcome.status !== "success" || !record(outcome.data)) return [];
  const data = outcome.data;
  const metadata = record(details) && record(details.metadata) ? details.metadata : undefined;
  const action = metadata && record(metadata.semanticAction) ? metadata.semanticAction : undefined;
  if (
    tool === "write" &&
    action?.kind === "direct-mutation" &&
    action.ok === true &&
    action.effect === "applied" &&
    Array.isArray(action.files)
  ) {
    return action.files
      .filter((file): file is string => typeof file === "string")
      .map((file) => `write ${display(file)}: saved`);
  }
  if (
    tool === "write" &&
    action === undefined &&
    record(details) &&
    details.effect === "not-applied" &&
    Array.isArray(details.results)
  ) {
    return details.results.flatMap((result: unknown) => {
      const item = record(result) && record(result.data) ? result.data : undefined;
      return item?.ok === true && typeof item.path === "string"
        ? [`write ${display(item.path)}: unchanged`]
        : [];
    });
  }
  if (data.effect !== "applied") return [];
  if (tool === "copy" || tool === "move") {
    if (
      action?.kind !== "file-operation" ||
      action.ok !== true ||
      action.effect !== "applied" ||
      typeof action.path !== "string" ||
      typeof action.target !== "string"
    )
      return [];
    return [`${tool} ${display(action.path)} → ${display(action.target)}: applied`];
  }
  // Provider actions and terminal input have their own receipts, not filesystem writes.
  if (tool !== "write" || action !== undefined || !Array.isArray(data.files)) return [];
  return data.files.flatMap((file: unknown) =>
    record(file) &&
    file.effect === "applied" &&
    typeof file.source === "string" &&
    !/^(?:shell|debug):/u.test(file.source)
      ? [`write ${display(file.source)}: saved`]
      : [],
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

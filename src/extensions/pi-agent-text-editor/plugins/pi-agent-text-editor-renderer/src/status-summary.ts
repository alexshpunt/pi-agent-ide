import type { MutationDiffStatus } from "pi-agent-text-editor/api/mutation-result";

/** Aggregate successful formatting by unique file and tool; leave failures identifiable. */
export function summarizeStatuses(
  resources: readonly {
    readonly path: string;
    readonly diffStatuses?: readonly MutationDiffStatus[];
  }[],
) {
  const formatted = new Set<string>();
  const formatters = new Set<string>();
  const alreadyFormatted = new Set<string>();
  const unchangedFormatters = new Set<string>();
  const remaining = new Map<string, { status: MutationDiffStatus; paths: Set<string> }>();
  for (const resource of resources)
    for (const status of resource.diffStatuses ?? []) {
      if (
        status.formatter !== undefined &&
        status.tone === "success" &&
        (status.formattingStatus === undefined ||
          status.formattingStatus === "changed" ||
          status.formattingStatus === "unchanged")
      ) {
        if (status.formattingStatus === "unchanged") {
          alreadyFormatted.add(resource.path);
          unchangedFormatters.add(status.formatter);
        } else {
          formatted.add(resource.path);
          formatters.add(status.formatter);
        }
        continue;
      }
      const key = JSON.stringify([status.text, status.tone]);
      let group = remaining.get(key);
      if (!group) {
        group = { status, paths: new Set() };
        remaining.set(key, group);
      }
      group.paths.add(resource.path);
    }
  return {
    formatted: [...formatted],
    formatters: [...formatters],
    alreadyFormatted: [...alreadyFormatted],
    unchangedFormatters: [...unchangedFormatters],
    statuses: [...remaining.values()].map(({ status, paths }) => ({ status, paths: [...paths] })),
  };
}

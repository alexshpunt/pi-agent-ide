import { requiredValue } from "pi-agent-invariant";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { IdeDiagnosticResult } from "#src/api/plugin-protocol.js";
import type { DiagnosticNotification } from "#src/core/diagnostic-store.js";

export const DIAGNOSTIC_ENTRY_TYPE = "ide-diagnostic-summary";

/** Display-only counts. Provider messages and source excerpts stay out of this entry. */
export interface DiagnosticEntryData {
  readonly filePath: string;
  readonly sources: readonly {
    readonly source: string;
    readonly status: IdeDiagnosticResult["status"];
    readonly counts: Readonly<Record<"error" | "warning" | "info" | "hint", number>>;
  }[];
}

/** Derive visible data from the exact report delivered to the model. */
export function diagnosticEntryData(notification: DiagnosticNotification): DiagnosticEntryData {
  return {
    filePath: notification.filePath,
    sources: notification.results.map((result) => {
      const counts = { error: 0, warning: 0, info: 0, hint: 0 };
      for (const item of result.diagnostics) counts[item.severity]++;
      return { source: result.source, status: result.status, counts };
    }),
  };
}

/** Render nonempty counts with their tool names; expanded entries also show completion state. */
export function renderDiagnosticEntry(
  data: DiagnosticEntryData,
  theme: Theme,
  expanded = false,
): Component {
  return {
    render(width) {
      const sources = data.sources.filter(
        (source) =>
          source.status !== "pending" &&
          source.status !== "unavailable" &&
          Object.values(source.counts).some((count) => count > 0),
      );
      if (sources.length === 0) return [];
      const summary = sources
        .map(
          (source) =>
            `${renderCounts(source.counts, theme)} ${theme.fg("dim", `(${plain(source.source)})`)}` +
            (source.status === "ready" ? "" : ` · ${theme.fg("dim", source.status)}`),
        )
        .join(" · ");
      const lines = [
        `${theme.fg("accent", "Diagnostics")} ${theme.fg("toolTitle", plain(data.filePath))} · ${summary}`,
      ];
      if (expanded) {
        for (const source of sources) {
          lines.push(
            `  ${theme.fg("dim", plain(source.source))} · ${renderCounts(source.counts, theme)} · ${theme.fg("dim", source.status)}`,
          );
        }
      }
      return new Text(lines.join("\n"), 0, 0).render(width);
    },
    invalidate() {},
  };
}

/** Register durable UI-only entries; appending one never adds model context or starts a turn. */
export function registerDiagnosticEntryRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<
    DiagnosticEntryData | { readonly files: readonly DiagnosticEntryData[] }
  >(DIAGNOSTIC_ENTRY_TYPE, (entry, options, theme) => {
    const data = requiredValue(entry.data);
    return "files" in data
      ? renderDiagnosticBatch(data.files, theme, options.expanded)
      : renderDiagnosticEntry(data, theme, options.expanded);
  });
}

/** One stable summary per delivery; expansion retains each file and provider. */
export function renderDiagnosticBatch(
  files: readonly DiagnosticEntryData[],
  theme: Theme,
  expanded = false,
): Component {
  return {
    render(width) {
      const visible = files.filter((file) =>
        file.sources.some(
          (source) =>
            source.status !== "pending" &&
            source.status !== "unavailable" &&
            Object.values(source.counts).some((count) => count > 0),
        ),
      );
      if (visible.length === 1 && visible[0])
        return renderDiagnosticEntry(visible[0], theme, expanded).render(width);
      if (visible.length === 0) return [];
      const counts = { error: 0, warning: 0, info: 0, hint: 0 };
      const providers = new Set<string>();
      for (const file of visible)
        for (const source of file.sources) {
          if (source.status === "pending" || source.status === "unavailable") continue;
          providers.add(source.source);
          for (const severity of ["error", "warning", "info", "hint"] as const)
            counts[severity] += source.counts[severity];
        }
      const head = new Text(
        `${theme.fg("accent", "Diagnostics")} · ${visible.length} files · ${renderCounts(counts, theme)} · ${providers.size} tools`,
        0,
        0,
      ).render(width);
      return expanded
        ? [
            ...head,
            ...visible.flatMap((file) => renderDiagnosticEntry(file, theme, true).render(width)),
          ]
        : head;
    },
    invalidate() {},
  };
}
function renderCounts(
  counts: DiagnosticEntryData["sources"][number]["counts"],
  theme: Theme,
): string {
  return (["error", "warning", "info", "hint"] as const)
    .filter((severity) => counts[severity] > 0)
    .map((severity) => {
      const count = counts[severity];
      const label = severity === "info" || count === 1 ? severity : `${severity}s`;
      const color =
        count > 0 && (severity === "error" || severity === "warning") ? severity : "muted";
      return theme.fg(color, `${count} ${label}`);
    })
    .join(", ");
}

function plain(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

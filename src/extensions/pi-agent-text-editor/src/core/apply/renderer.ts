import { isDiffOutcome, diffPresentation } from "#src/core/diff-tool.js";
import { createApplySourceProjection, type ApplyCallPreview } from "./mixed-source.js";
import { isFileOperationResult, formatFileOperation } from "#src/core/file-operations.js";
import { createReadResultRenderer } from "pi-agent-read/api/rendering";
import type { ReadToolResult } from "pi-agent-read/api/tools/read";
import { Text, type Component } from "@earendil-works/pi-tui";
import type { FileMutationBatchResult } from "#src/api/mutation-result.js";
import { finalApplyMutations } from "./final-mutations.js";
import { highlightCode, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { preserveEnclosingBackground } from "pi-agent-tool-ui";
import type { ApplyResults } from "./results.js";
import type { ApplyOutput } from "./output.js";

/** Deliberate user presentation, separate from model-facing operation receipts. */
export interface ApplyDisplay {
  readonly blocks: readonly { readonly text: string; readonly read?: ReadToolResult }[];
  readonly mutations?: FileMutationBatchResult;
  readonly comparisons?: readonly FileMutationBatchResult[];
  readonly cwd?: string;
}

/** Build readable result blocks without exposing internal mutation receipts. */
export function createApplyDisplay(
  results: ApplyResults,
  output: ApplyOutput,
  error?: unknown,
  cwd = process.cwd(),
): ApplyDisplay {
  const selected = results.select();
  const diffEntries = [
    ...selected.automatic,
    ...selected.explicit.filter((entry) => entry.kind === "operation"),
  ].filter((entry) => isDiffOutcome(entry.value) && !entry.value.equal);
  const comparisons = diffEntries.flatMap((entry) =>
    isDiffOutcome(entry.value) ? [diffPresentation(entry.value, cwd)] : [],
  );
  const diffBlocks = new Set(diffEntries.flatMap((entry) => entry.presentation?.content ?? []));
  if (selected.files.length === 0) {
    const reads = [
      ...selected.automatic.map((entry) => entry.presentation),
      ...selected.explicit.map((entry) =>
        entry.kind === "operation" ? entry.presentation : undefined,
      ),
    ].filter((read): read is ReadToolResult => read !== undefined);
    return {
      comparisons,
      cwd,
      blocks: output.content
        .filter((block) => !diffBlocks.has(block))
        .flatMap((block) =>
          block.type === "text"
            ? [
                {
                  text: block.text,
                  read: reads.find((read) => read.content.includes(block)),
                },
              ]
            : [],
        ),
    };
  }
  const mutations = finalApplyMutations(results);
  return {
    ...(mutations.length > 0 ? { mutations: { results: mutations } } : {}),
    comparisons,
    cwd,
    blocks: [
      ...selected.explicit.flatMap((entry) => {
        if (entry.kind === "operation" && isDiffOutcome(entry.value) && !entry.value.equal)
          return [];
        if (isFileOperationResult(entry.value)) return [{ text: formatFileOperation(entry.value) }];
        if (entry.kind === "operation")
          return (
            entry.presentation?.content.flatMap((block) =>
              block.type === "text" ? [{ text: block.text, read: entry.presentation }] : [],
            ) ?? []
          );
        return [
          {
            text:
              typeof entry.value === "string"
                ? entry.value
                : entry.value === undefined
                  ? "undefined"
                  : JSON.stringify(entry.value, null, 2),
          },
        ];
      }),
      ...selected.automatic.flatMap(({ value, presentation }) => {
        if (isFileOperationResult(value)) return [{ text: formatFileOperation(value) }];
        if (
          value !== null &&
          typeof value === "object" &&
          "kind" in value &&
          value.kind === "index-operation"
        )
          return (
            presentation?.content.flatMap((block) =>
              block.type === "text" ? [{ text: block.text }] : [],
            ) ?? []
          );
        if (
          value === null ||
          typeof value !== "object" ||
          !("errors" in value) ||
          !Array.isArray(value.errors)
        )
          return [];
        return value.errors.flatMap((error: unknown) =>
          error !== null &&
          typeof error === "object" &&
          "message" in error &&
          typeof error.message === "string"
            ? [{ text: error.message }]
            : [],
        );
      }),
      ...(error === undefined
        ? []
        : [{ text: error instanceof Error ? error.message : JSON.stringify(error) }]),
    ],
  };
}

type RenderState = {
  applyResultReady?: boolean;
  displaySource?: string;
  codeView?: boolean;
  projectSource?: (source: string) => string;
};

/** Width-safe rows sharing one frame across the call and its appended result. */
export function applyFrameRows(
  source: string,
  theme: Theme,
  width: number,
  part: "call" | "result",
  finish: boolean,
  language?: string,
  failed = false,
): string[] {
  const size = Math.max(1, width);
  if (size < 5) return source.split("\n").flatMap((line) => wrapTextWithAnsi(line, size));
  const inner = size - 4;
  const border = (value: string) => theme.fg("borderMuted", value);
  const heading = part === "call" ? "Apply · JavaScript" : "Result";
  const title = truncateToWidth(` ${heading} `, size - 4, "");
  const rows = [
    border(`${part === "call" ? "╭" : "├"}─`) +
      theme.fg(failed ? "error" : "accent", title) +
      border(
        `${"─".repeat(Math.max(0, size - visibleWidth(title) - 3))}${part === "call" ? "╮" : "┤"}`,
      ),
  ];
  const blank = `${border("│")}${" ".repeat(size - 2)}${border("│")}`;
  for (const line of source.split("\n")) {
    const highlighted =
      language === "diff"
        ? theme.fg(
            line.startsWith("+")
              ? "toolDiffAdded"
              : line.startsWith("-")
                ? "toolDiffRemoved"
                : "toolDiffContext",
            line,
          )
        : language
          ? highlightCode(line, language).join("\n")
          : theme.fg("toolOutput", line);
    for (const wrapped of wrapTextWithAnsi(highlighted, inner))
      rows.push(
        `${border("│")} ${wrapped}${" ".repeat(Math.max(0, inner - visibleWidth(wrapped)))} ${border("│")}`,
      );
  }
  if (part === "call") rows.push(blank);
  if (finish) rows.push(border(`╰${"─".repeat(size - 2)}╯`));
  const background = theme.getBgAnsi("toolPendingBg");
  return rows.map((row) => background + preserveEnclosingBackground(row, background) + "\u001b[0m");
}

/** Compose compact written calls with a pure configured tool header renderer. */
export function createApplyCallRenderer(
  renderWritten?: (call: ApplyCallPreview, theme: Theme) => string,
): NonNullable<ToolDefinition["renderCall"]> {
  return (args, theme, context) => {
    const state = context.state as RenderState;
    const projectSource = (state.projectSource ??= createApplySourceProjection(
      renderWritten ? (call) => renderWritten(call, theme) : undefined,
      renderWritten ? (code) => highlightCode(code, "javascript").join("\n") : undefined,
    ));
    const source =
      args !== null &&
      typeof args === "object" &&
      "source" in args &&
      typeof args.source === "string"
        ? args.source
        : "";
    return {
      invalidate() {},
      render(width) {
        return applyFrameRows(
          state.codeView || context.expanded
            ? (state.displaySource ?? source)
            : projectSource(state.displaySource ?? source),
          theme,
          width,
          "call",
          !state.applyResultReady,
          state.codeView || context.expanded || !renderWritten ? "javascript" : undefined,
        );
      },
    };
  };
}

export const renderApplyCall = createApplyCallRenderer();

/** Configured editor presentation for final mutations inside the Apply card. */
export type ApplyMutationPanel = (
  details: FileMutationBatchResult,
  theme: Theme,
  expanded: boolean,
  cwd: string,
) => Component;

/** Reuse the owning editor renderer without introducing a core-to-plugin dependency. */
export function createApplyResultRenderer(
  panel?: ApplyMutationPanel,
): NonNullable<ToolDefinition["renderResult"]> {
  return (result, options, theme, context) => {
    (context.state as RenderState).applyResultReady = true;
    const details = result.details as
      | { display?: ApplyDisplay; displaySource?: string }
      | undefined;
    (context.state as RenderState).displaySource = details?.displaySource;
    const display = details?.display;
    const blocks: ApplyDisplay["blocks"] = display?.blocks ?? [
      { text: context.isError ? "Apply failed" : "Apply finished" },
    ];
    const renderRead = createReadResultRenderer({ kind: "source" });
    const readPanels = blocks.map((block) =>
      renderRead(
        block.read ?? {
          content: [{ type: "text", text: block.text }],
          details: jsonDetails(block.text),
        },
        options,
        theme,
        { ...context, isError: false, lastComponent: undefined },
      ),
    );
    const mutations = display?.mutations;
    const comparisonPanels = (display?.comparisons ?? []).flatMap((details) => {
      const rendered = panel?.(details, theme, options.expanded, display?.cwd ?? process.cwd());
      return [
        rendered ??
          new Text(
            (details.results ?? []).flatMap((result) => result.data.diffs ?? []).join("\n"),
            0,
            0,
          ),
      ];
    });
    const mutationPanel =
      mutations === undefined
        ? undefined
        : panel?.(mutations, theme, options.expanded, display?.cwd ?? process.cwd());
    return {
      invalidate() {
        mutationPanel?.invalidate();
        for (const comparison of comparisonPanels) comparison.invalidate();
      },
      render(width) {
        const body: string[] = [];
        for (const panel of readPanels) {
          const rows = panel.render(Math.max(1, width - 4));
          if (rows.length === 0) continue;
          if (body.length > 0) body.push("");
          body.push(...rows);
        }
        for (const comparison of comparisonPanels) {
          if (body.length > 0) body.push("");
          body.push(...comparison.render(Math.max(1, width - 4)));
        }
        if (mutationPanel !== undefined) {
          const rows = mutationPanel.render(Math.max(1, width - 4));
          if (body.length > 0 && rows.length > 0) body.push("");
          body.push(...rows);
        } else if (mutations !== undefined)
          body.push(...(mutations.results ?? []).map((file) => file.path ?? "Changed file"));
        if (
          body.length === 0 &&
          blocks.length > 0 &&
          blocks.every(
            (block) =>
              block.read?.details.diagnosticCheck?.complete &&
              block.read.details.diagnosticCheck.count === 0,
          )
        )
          return applyFrameRows("", theme, width, "result", true).slice(-1);
        return applyFrameRows(
          body.length === 0 ? "No output" : body.join("\n"),
          theme,
          width,
          "result",
          true,
          undefined,
          context.isError,
        );
      },
    };
  };
}

function jsonDetails(text: string): { source?: string } {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? { source: "result.json" } : {};
  } catch {
    return {};
  }
}
export const renderApplyResult = createApplyResultRenderer();

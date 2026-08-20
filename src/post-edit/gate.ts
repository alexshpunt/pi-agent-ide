import path from "node:path";

import { Gate } from "#src/toolchain/gate.js";
import { getActiveToolchain, isToolchainReady, warmup } from "#src/toolchain/registry.js";
import {
  computeChangedRanges,
  type DiagnosticHint,
} from "pi-agent-text-editor/api/mutation-result";

import type { ActiveToolchain, Diagnostic, GateResult } from "#src/toolchain/types.js";
import type {
  TextMutationResultContributionData,
  TextPostEditTransaction,
} from "pi-agent-text-editor/api/post-edit";

const MAX_SYNTAX_ERRORS = 5;
const DIAGNOSTIC_SEVERITY_RANK: Record<Diagnostic["severity"], number> = {
  error: 0,
  warning: 1,
  info: 2,
  hint: 3,
};

export type IdePostEditGateRunner = (
  filePath: string,
  toolchain: ActiveToolchain,
) => Promise<GateResult>;

export async function runIdePostEditGate(
  transaction: TextPostEditTransaction,
  runGate: IdePostEditGateRunner = runToolchainGate,
): Promise<TextMutationResultContributionData | undefined> {
  if (!path.isAbsolute(transaction.resourceSource)) {
    return undefined;
  }

  let toolchain = getActiveToolchain();

  if (!isToolchainReady() || toolchain.ctx.cwd !== transaction.cwd) {
    toolchain = await warmup({ cwd: transaction.cwd });
  }

  const gateResult = await runGate(transaction.resourceSource, toolchain);
  const fileResult = gateResult.files.find(
    (result) => result.filePath === transaction.resourceSource,
  );
  const finalContent = fileResult?.finalContent ?? transaction.requestedAfter.content;
  const finalLines = normalizedLines(finalContent);
  const compile = fileResult?.compile;
  const syntaxDiagnostics = compile?.syntaxErrors ?? [];
  const hints: DiagnosticHint[] = [];

  const addHint = (diagnostic: Diagnostic, source: string): void => {
    if (
      !Number.isInteger(diagnostic.line) ||
      diagnostic.line < 1 ||
      diagnostic.line > finalLines.length
    ) {
      return;
    }

    hints.push({
      file: transaction.source,
      line: diagnostic.line,
      column: diagnostic.column,
      lineText: finalLines[diagnostic.line - 1] ?? "",
      severity: diagnostic.severity,
      source,
      code: diagnostic.code,
      message: diagnostic.message,
    });
  };

  for (const diagnostic of syntaxDiagnostics) {
    addHint(diagnostic, "compiler");
  }

  if (syntaxDiagnostics.length === 0) {
    const compilerDiagnostics = compile?.otherDiagnostics ?? [];

    if (compilerDiagnostics.length > 0) {
      for (const diagnostic of compilerDiagnostics) {
        addHint(diagnostic, "compiler");
      }
    } else {
      for (const diagnostic of fileResult?.lint.diagnostics ?? []) {
        addHint(diagnostic, "linter");
      }
    }
  }

  const shownSyntaxErrors = selectSyntaxDiagnostics(
    syntaxDiagnostics,
    transaction.before.content,
    finalContent,
  ).length;

  return {
    hints,
    scopeMarkers: {},
    warnings: [],
    ...(syntaxDiagnostics.length > MAX_SYNTAX_ERRORS && {
      syntaxErrorSummary: { total: syntaxDiagnostics.length, shown: shownSyntaxErrors },
    }),
  };
}

function runToolchainGate(filePath: string, toolchain: ActiveToolchain): Promise<GateResult> {
  return new Gate(toolchain).runAll([filePath]);
}

function selectSyntaxDiagnostics(
  diagnostics: readonly Diagnostic[],
  beforeContent: string,
  afterContent: string,
): Diagnostic[] {
  const changedRanges = computeChangedRanges(beforeContent, afterContent);
  const visible = diagnostics.filter((diagnostic) =>
    changedRanges.some((range) => diagnostic.line >= range.start && diagnostic.line <= range.end),
  );
  const hidden = diagnostics
    .filter((diagnostic) => !visible.includes(diagnostic))
    .sort(compareDiagnostics);

  return [...visible, ...hidden.slice(0, Math.max(0, MAX_SYNTAX_ERRORS - visible.length))];
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  return (
    DIAGNOSTIC_SEVERITY_RANK[left.severity] - DIAGNOSTIC_SEVERITY_RANK[right.severity] ||
    left.line - right.line ||
    left.column - right.column ||
    left.code.localeCompare(right.code)
  );
}

function normalizedLines(content: string): string[] {
  const normalized = content.replaceAll("\r\n", "\n");

  if (normalized.length === 0) {
    return [];
  }

  return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
}

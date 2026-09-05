import { renderAgentDiff } from "./agent-diff.js";
import { renderFinalStateFragment } from "./final-state-fragment.js";
import { type FileMutationResult } from "./file-mutation-result.js";

// ─── Agent-facing result formatter ───────────────────────────────────────

/**
 * Wraps FileMutationResult and generates the text that goes to the agent
 * as content[0].text. Separates presentation logic from the data model.
 *
 * Replaces the inline textResult() calls inside engine.ts and the
 * formatEditFailure() / failureResult() functions from errors.ts.
 */
export class FileMutationAgentResult {
  private readonly results: FileMutationResult[];

  public constructor(results: FileMutationResult | FileMutationResult[]) {
    this.results = Array.isArray(results) ? results : [results];
  }

  /**
   * Generate the agent-facing text.
   * Returned string is suitable for content[0].text in a tool response.
   */
  public toText(): string {
    const parts: string[] = Array.from(this.results, (fmr) => this.formatSingle(fmr));

    return parts.join("\n\n");
  }

  /**
   * Generate agent-facing content block.
   * Returns { type: "text", text } suitable for content[] in tool response.
   */
  public toTextContent(): { type: "text"; text: string } {
    return { type: "text", text: this.toText() };
  }

  private formatSingle(fmr: FileMutationResult): string {
    if (fmr.isPartial) {
      return "gate progress";
    }

    if (!fmr.ok) {
      return this.formatFailure(fmr);
    }

    // ok, but no actual changes — e.g. new FileMutationResult(undefined)
    if (fmr.diffs.length === 0 && fmr.files.length === 0) {
      return "<empty-result>";
    }

    return this.formatSuccess(fmr);
  }

  // ── Failure formatting ────────────────────────────────────────────────

  private formatFailure(fmr: FileMutationResult): string {
    // Special case: all edits were stale anchors (without detailed staleDiagnostic)
    if (
      fmr.errors.some((e) => e.code === "STALE_ANCHOR") &&
      fmr.staleEdits.length > 0 &&
      !fmr.staleDiagnostic
    ) {
      return this.formatStaleFailure(fmr);
    }

    const lines: string[] = [
      `EDIT_FAILED (${fmr.errors.length} error${fmr.errors.length === 1 ? "" : "s"})`,
      "",
    ];

    // Header

    // Path
    if (fmr.path) {
      lines.push(`Path: ${fmr.path}`);
    }

    // Requested range
    if (fmr.editRange) {
      const endString =
        fmr.editRange.end.anchor === "?" ? fmr.editRange.start.anchor : fmr.editRange.end.anchor;
      lines.push(`Requested range: ${fmr.editRange.start.anchor} .. ${endString}`);
    }

    // Failure context
    if (fmr.failurePoint) {
      lines.push(`Failure point: ${fmr.failurePoint}`);
    }

    if (fmr.expectedAnchor) {
      lines.push(`Expected anchor: ${fmr.expectedAnchor}`);
    }

    if (fmr.currentAnchor) {
      lines.push(`Current anchor: ${fmr.currentAnchor}`);
    }

    // Internal error details
    if (fmr.internalErrorType || fmr.internalErrorMessage) {
      lines.push(`Internal error type: ${fmr.internalErrorType ?? "unknown"}`);
      lines.push(`Internal error message: ${fmr.internalErrorMessage ?? "unknown"}`);
      lines.push("Operator hint: this is a tool bug, not an agent edit mistake.");
      lines.push("");
    }

    // Recovery hint
    if (fmr.recovery) {
      lines.push("Recovery:");

      for (const line of fmr.recovery.split("\n")) {
        lines.push(`  ${line}`);
      }

      lines.push("");
    }

    // Fresh anchors
    if (fmr.freshAnchors && fmr.freshAnchors.length > 0) {
      lines.push("Fresh nearby anchors:");

      for (const a of fmr.freshAnchors) {
        lines.push(`  ${a}`);
      }
    }

    // ── Diffs (successful edits in mixed multi-file) ──────────────
    for (const diff of fmr.diffs) {
      const path = /^--- (.+)$/m.exec(diff)?.[1] ?? fmr.path ?? "<unknown file>";
      lines.push(...renderAgentDiff(fmr, path));
    }

    // ── Files ────────────────────────────────────────────────────────
    if (fmr.files.length > 0) {
      const created = fmr.createdFiles;
      const edited = fmr.overwrittenFiles;

      if (created.length > 0) {
        lines.push("");
        lines.push("Created:");

        for (const f of created) {
          const size = f.size === undefined ? "" : ` (${f.size} bytes)`;
          lines.push(`  ${f.path}${size}`);
        }
      }

      if (edited.length > 0) {
        lines.push("");
        lines.push("Edited:");

        for (const f of edited) {
          lines.push(`  ${f.path}`);
        }
      }
    }

    // ── Diagnostics ──────────────────────────────────────────────────
    const syntaxWarnings = fmr.warnings.filter((w) => w.severity === "syntax");
    const diagWarnings = fmr.warnings.filter((w) => w.severity === "diagnostic");

    if (syntaxWarnings.length > 0) {
      lines.push("");
      lines.push("Syntax diagnostics:");

      for (const w of syntaxWarnings) {
        for (const m of w.messages) {
          lines.push(`  ${m}`);
        }
      }
    }

    if (syntaxWarnings.length === 0 && diagWarnings.length > 0) {
      lines.push("");
      lines.push("Diagnostics:");

      for (const w of diagWarnings) {
        for (const m of w.messages) {
          lines.push(`  ${m}`);
        }
      }
    }

    // Proposed diff (WRITE_FAILED: changes that were NOT written)
    if (fmr.proposedDiff) {
      lines.push("", "Proposed diff was not applied:", fmr.proposedDiff);
    }

    // Edit indices (which edit failed)
    if (fmr.editIndex !== undefined) {
      lines.push("", `Edit index: ${fmr.editIndex}`);
    }

    if (fmr.editIndices !== undefined && fmr.editIndices.length > 0) {
      lines.push("", `Edit indices: ${fmr.editIndices.join(", ")}`);
    }

    // Stale diagnostic (detailed stale anchor with context)
    if (fmr.staleDiagnostic) {
      const sd = fmr.staleDiagnostic;
      lines.push("", `target: ${fmr.path ?? "?"}`);
      lines.push(`line: ${sd.lineNumber}`, "");
      lines.push("expected:");
      lines.push(`  ${sd.expected.lineNumber}#${sd.expected.hash}  (original text unavailable)`);
      lines.push("", "current:");
      lines.push(`  ${sd.current.lineNumber}#${sd.current.hash}  ${sd.current.text}`);
      lines.push("", `anchor_hash_changed: ${sd.anchorHashChanged}`);

      if (sd.currentContext.length > 0) {
        lines.push("", "current_context:");

        for (const context of sd.currentContext) {
          const marker = context.lineNumber === sd.lineNumber ? ">>" : "  ";
          lines.push(`  ${marker} ${context.lineNumber}#${context.hash}  ${context.text}`);
        }
      }
    }

    // A rejected mutation describes only the blocked operation, not changes
    // already applied by the batch.
    const isMutationRejected = fmr.errors.some((error) => error.code === "MUTATION_REJECTED");

    if (fmr.fileChangedStatement !== undefined) {
      lines.push("", fmr.fileChangedStatement);
    } else if (!isMutationRejected) {
      lines.push("", "No file was changed.");
    }

    // File-level errors (WriteResultDetails blocked/failed, etc.)

    for (const error of fmr.errors) {
      lines.push("");
      const isMutationRejection = error.code === "MUTATION_REJECTED";

      if (!isMutationRejection) {
        lines.push(`Failed: ${error.code ?? "ERROR"}`);
      }

      if (error.path && error.path !== fmr.path) {
        lines.push(`${isMutationRejection ? "" : "  "}Path: ${error.path}`);
      }

      if (error.reason) {
        lines.push(`${isMutationRejection ? "" : "  "}Reason: ${error.reason}`);
      }
    }

    // ── LSP diagnostics reminder ───────────────────────────────────────
    if (fmr.hints.length > 0) {
      lines.push("");
      lines.push("---");
      lines.push(
        "LSP diagnostics detected. You MUST fix all LSP issues before the result is accepted.",
      );
    }

    return lines.join("\n");
  }
  private formatStaleFailure(fmr: FileMutationResult): string {
    const lines: string[] = ["EDIT_FAILED", ""];

    if (fmr.staleEdits.length > 0) {
      lines.push(`All ${fmr.staleEdits.length} edits have stale anchors:`);

      for (const s of fmr.staleEdits) {
        lines.push(`edits[${s.index}]: STALE_ANCHOR (${s.failurePoint})`);
      }

      lines.push("");
    }

    // Fresh anchors: rendered context around the stale area
    if (fmr.freshAnchors && fmr.freshAnchors.length > 0) {
      lines.push("Current nearby anchors:");

      for (const a of fmr.freshAnchors) {
        lines.push(`  ${a}`);
      }
    }

    return lines.join("\n");
  }

  // ── Success formatting ────────────────────────────────────────────────

  private formatSuccess(fmr: FileMutationResult): string {
    const blocks: string[] = [];

    for (const diff of fmr.diffs) {
      const path = /^--- (.+)$/m.exec(diff)?.[1] ?? fmr.path ?? "<unknown file>";
      blocks.push(renderFinalStateFragment(fmr, path).join("\n"));
    }

    if (blocks.length === 0) {
      for (const file of fmr.files) {
        blocks.push(file.path);
      }
    }

    return blocks.join("\n\n");
  }
}

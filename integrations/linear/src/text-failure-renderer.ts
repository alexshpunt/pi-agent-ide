import { Text } from "@earendil-works/pi-tui";
import type { TextEditorPluginApi } from "pi-agent-ide/api/text-editor";
import { parseTextAddress } from "./text-address.ts";
import { parseLinearFieldAddress } from "./fields.ts";
import {
  axiTimeout,
  linearFailureReasons,
  parseLinearResourceFailure,
} from "./resource-failure.ts";

const causes = {
  LINEAR_READBACK_UNAVAILABLE: "Could not read the saved resource. Read it again before editing.",
  LINEAR_AXI_FAILED: "The Linear request failed.",
  LINEAR_AXI_TIMEOUT: axiTimeout,
  LINEAR_SAVE_FAILED: "The Linear save could not be acknowledged.",
  LINEAR_CREATE_FAILED: "The Linear creation could not be acknowledged.",
  LINEAR_AUTH_REQUIRED: "Linear authorization is required.",
  LINEAR_NOT_FOUND: "The Linear resource was not found.",
  LINEAR_INVALID_RESPONSE: "Linear returned an unreadable response.",
  LINEAR_STALE_CONTENT: "The resource changed since it was read.",
  LINEAR_SNAPSHOT_UNVERIFIED:
    "No verified edit snapshot is available. Read the original resource without jq before editing.",
} as const;
interface FailurePanel {
  readonly effect: "applied" | "not-applied" | "unknown";
  readonly label: string;
  readonly reasons: readonly string[];
  readonly restored: number;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function owns(source: string): boolean {
  try {
    return (
      !!parseTextAddress(source) ||
      !!parseLinearFieldAddress(source) ||
      /^linear:\/\/[A-Za-z0-9_-]+\/(issue|project|document)\/[^/?#]+\/comment\/[0-9a-f-]{36}#body$/iu.test(
        source,
      )
    );
  } catch {
    return false;
  }
}
function cause(error: Record<string, unknown>): string | undefined {
  if (typeof error.path !== "string" || !owns(error.path)) return;
  let code = error.code;
  if (
    (code === "WRITE_FAILED" || code === "POST_WRITE_FAILED" || code === "INVALID_REQUEST") &&
    typeof error.reason === "string"
  ) {
    const prefix = `Unable to write ${error.path}: `;
    const reason = error.reason.startsWith(prefix)
      ? error.reason.slice(prefix.length)
      : error.reason;
    const match = /^(LINEAR_[A-Z_]+): (.+?)(?:\.)?$/u.exec(reason);
    if (!match || match[2] !== error.path) return;
    code = match[1];
  }
  if (typeof code !== "string") return;
  if (Object.hasOwn(causes, code)) return causes[code as keyof typeof causes];
  const failure = parseLinearResourceFailure(code);
  return failure ? linearFailureReasons[failure.reason] : undefined;
}
function panel(value: unknown): FailurePanel | undefined {
  const details = object(object(value)?.details);
  const effect = details?.effect;
  if (!details || (effect !== "applied" && effect !== "not-applied" && effect !== "unknown"))
    return;
  if (!Array.isArray(details.results)) return;
  const reasons = new Set<string>();
  let rollback = false;
  let failed = 0;
  let restored = 0;
  for (const result of details.results) {
    const data = object(object(result)?.data);
    if (!data) return;
    if (data.rollback !== undefined) {
      const state = object(data.rollback);
      if (!Array.isArray(state?.failedSources) || !Array.isArray(state.restoredSources)) return;
      rollback = true;
      failed += state.failedSources.length;
      restored += state.restoredSources.length;
    }
    if (data.errors === undefined) continue;
    if (!Array.isArray(data.errors) || data.kind === "ok" || data.ok === true) return;
    for (const error of data.errors) {
      const fields = object(error);
      const reason = fields && cause(fields);
      // Mixed or unknown failures belong to the common renderer, not this provider panel.
      if (!reason) return;
      reasons.add(reason);
    }
  }
  if (!reasons.size) return;
  let label =
    effect === "unknown"
      ? "Effects unknown · edit failed"
      : effect === "applied"
        ? "Saved · follow-up unavailable"
        : "Not changed · edit failed";
  if (rollback) {
    if (failed) label = "State unknown · rollback failed";
    else if (effect !== "unknown") label = "Rolled back · write failed";
  } else if (effect === "not-applied" && object(details.metadata)?.rollback === "restored") {
    label = "Rolled back · edit failed";
  }
  return { effect, label, reasons: [...reasons], restored };
}

/** Add safe Linear failure panels; other providers and successful edits keep their renderer. */
export function registerLinearFailureRenderers(
  api: Pick<TextEditorPluginApi, "addToolRenderer">,
): void {
  for (const tool of ["write", "replace", "insert", "delete", "copy", "move"]) {
    api.addToolRenderer({
      tool,
      matches: (value, phase) => phase === "result" && panel(value) !== undefined,
      renderResult(result, _options, theme) {
        const failure = panel(result);
        if (!failure) return new Text("", 0, 0);
        const lines = [failure.label, ...failure.reasons.map((reason) => `Reason: ${reason}`)];
        if (failure.restored) lines.push(`Restored resources: ${failure.restored}`);
        if (failure.effect === "unknown") lines.push("Read the affected resource before retrying.");
        return new Text(
          theme.fg(failure.effect === "applied" ? "warning" : "error", lines.join("\n")),
          0,
          0,
        );
      },
    });
  }
}

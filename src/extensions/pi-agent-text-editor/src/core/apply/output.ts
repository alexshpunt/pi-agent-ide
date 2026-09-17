import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { isAgentContent } from "pi-agent-resource";
import type { ReadPluginApi } from "pi-agent-read/api/plugin-protocol";
import type { ReadToolResult, ReadResultDetails } from "pi-agent-read/api/tools/read";
import type { ResourceResolverContext } from "pi-agent-resource";
import type { ApplyResults } from "#src/core/apply/results.js";
import { FileMutationAgentResult } from "#src/core/mutation-result/file-mutation-agent-result.js";
import { finalApplyMutations } from "./final-mutations.js";
import { serializeApplyError } from "#src/core/apply/runtime.js";

type Content = ReadToolResult["content"];
/** Output level is presentation only; full data stays in the host ledger. */
export interface ApplyOutput {
  readonly content: Content;
  readonly level: "full" | "compact" | "summary";
  readonly temporarySource?: string;
  readonly mutations?: ReturnType<typeof finalApplyMutations>;
}

/** Presents net file effects once, preserving native images and one combined text budget. */
export async function renderApplyOutput(
  results: ApplyResults,
  read: Pick<ReadPluginApi, "saveTemporary"> & Partial<Pick<ReadPluginApi, "reduceOutput">>,
  error?: unknown,
  context: ResourceResolverContext = { cwd: process.cwd() },
): Promise<ApplyOutput> {
  const selected = results.select();
  const sections: { content: Content; read?: ReadToolResult }[] = selected.explicit.map(
    (entry) => ({
      content: renderValue(
        entry.kind === "operation" ? (entry.presentation ?? entry.value) : entry.value,
      ),
      read:
        entry.kind === "operation" ? (entry.presentation ?? asReadResult(entry.value)) : undefined,
    }),
  );
  const content: Content = sections.flatMap((section) => section.content);
  const mutations = selected.automatic.filter(({ kind }) => kind === "mutation");
  for (const operation of selected.automatic) {
    if (
      operation.kind === "read" ||
      hasOperationWarnings(operation.value) ||
      isFailure(operation.value) ||
      (operation.value !== null &&
        typeof operation.value === "object" &&
        "kind" in operation.value &&
        (operation.value.kind === "file-operation" || operation.value.kind === "index-operation"))
    ) {
      const section = {
        content: renderValue(operation.presentation ?? operation.value),
        read:
          operation.kind === "read"
            ? (operation.presentation ?? asReadResult(operation.value))
            : undefined,
      };
      sections.push(section);
      content.push(...section.content);
    }
  }
  for (const operation of mutations) {
    const value = operation.value;
    if (!isFailure(value) && value !== null && typeof value === "object" && "metadata" in value) {
      const section = { content: renderValue(value.metadata), read: undefined };
      sections.push(section);
      content.push(...section.content);
    }
  }
  const suffixStart = content.length;
  const finalMutations = finalApplyMutations(results);
  if (finalMutations.length > 0)
    content.push(new FileMutationAgentResult(finalMutations).toTextContent());
  if (error !== undefined) content.push(text(formatError(error)));
  if (content.length === 0) content.push(text("No operations or explicit results."));
  const full = textContent(content);
  if (!truncateHead(full).truncated) return { content, level: "full", mutations: finalMutations };
  const temporarySource = await read.saveTemporary(full);
  const footer = `\n\nFull Apply output: ${temporarySource}. Read this reference with offset/limit for more.`;
  if (read.reduceOutput !== undefined && !context.signal?.aborted) {
    const compact: Content = [];
    const reducibleSections = sections.flatMap(expandReadSection);
    const quota = Math.max(
      1,
      reducibleSections.filter((section) => section.read !== undefined).length,
    );
    for (const section of reducibleSections) {
      let reduced: ReadToolResult | undefined;
      if (section.read !== undefined) {
        try {
          reduced = await read.reduceOutput(section.read, context, {
            maxBytes: Math.floor((DEFAULT_MAX_BYTES - Buffer.byteLength(footer)) / quota),
            maxLines: Math.floor((DEFAULT_MAX_LINES - 3) / quota),
          });
        } catch {
          /* Reduction is optional; keep the recorded result when it fails. */
        }
      }
      compact.push(...(reduced?.content ?? section.content));
    }
    compact.push(...content.slice(suffixStart));
    compact.push(text(footer.trimStart()));
    if (!truncateHead(textContent(compact)).truncated)
      return { content: compact, level: "compact", temporarySource, mutations: finalMutations };
  }
  const summary = [
    `Apply output reduced: ${selected.automatic.length} automatic results, ${selected.explicit.length} explicit results, ${selected.files.length} final files.`,
    ...(error === undefined ? [] : [formatError(error)]),
    ...selected.automatic
      .filter(({ value }) => isFailure(value))
      .map(({ value, presentation }) => textContent(renderValue(presentation ?? value))),
    ...selected.files.map(({ source }) => source),
  ].join("\n");
  const bounded = truncateHead(summary, {
    maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(footer),
    maxLines: DEFAULT_MAX_LINES - 3,
  }).content;
  return {
    content: [text(bounded + footer), ...content.filter((block) => block.type === "image")],
    level: "summary",
    temporarySource,
    mutations: finalMutations,
  };
}

function text(value: string): Content[number] {
  return { type: "text", text: value };
}
function textContent(content: Content): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
}
function expandReadSection(section: {
  content: Content;
  read?: ReadToolResult;
}): { content: Content; read?: ReadToolResult }[] {
  const resources = section.read?.details.resources;
  return resources?.length
    ? resources.flatMap((read) => expandReadSection({ content: read.content, read }))
    : [section];
}
function hasOperationWarnings(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "operations" in value &&
    Array.isArray(value.operations) &&
    (value.operations as unknown[]).some(
      (item) =>
        item !== null && typeof item === "object" && "status" in item && item.status === "warning",
    )
  );
}
function isFailure(value: unknown): boolean {
  return value !== null && typeof value === "object" && "ok" in value && value.ok === false;
}
function formatError(error: unknown): string {
  const failure = serializeApplyError(error);
  return formatApplyFailure(failure.code, failure.message);
}

function formatApplyFailure(code: string, message: string): string {
  const guidance: Readonly<Record<string, string>> = {
    NOT_FOUND:
      "The requested text or selection was not found. Read the current file and select existing text.",
    AMBIGUOUS_MATCH:
      "The selection matched more than once. Use a larger unique fragment or a current candidate anchor.",
    STALE_EDITOR:
      "This editor handle was already committed. Open the file again before staging more changes.",
    STALE_SELECTION:
      "The search selection no longer matches the file. Search again and use the fresh match.",
    INVALID_SELECTION:
      "The selected line or range is invalid. Read the file and select a range inside its current bounds.",
    STALE_SNAPSHOT:
      "A touched file changed after it was opened. Open it again and rebuild the transaction.",
    INVALID_TRANSACTION:
      "The staged operations conflict or overlap. Build non-overlapping selections from the original snapshots.",
    TRANSACTION_FAILED:
      "The commit failed after it started. Check the reported rollback state before retrying.",
    EEXIST: "The destination already exists. Choose another path or explicitly enable overwrite.",
    ENOENT: "A source path does not exist. Check the path and retry.",
    RUN_PARSE_ERROR:
      "The Apply JavaScript could not be parsed. Fix the reported syntax and run it again.",
    RUN_RUNTIME_ERROR:
      "The Apply JavaScript failed. Fix the reported operation or API usage and run it again.",
  };
  const hint = guidance[code];
  return hint === undefined
    ? `${code}: ${message}`
    : `${code}: ${message}
${hint}`;
}

function renderValue(value: unknown): Content {
  if (isAgentContent(value))
    return value.map((block) => (block.type === "custom" ? text(JSON.stringify(block)) : block));
  if (
    value !== null &&
    typeof value === "object" &&
    "operation" in value &&
    typeof value.operation === "string"
  ) {
    const lines = [
      `${value.operation}: ${isFailure(value) && "effect" in value && value.effect === "applied" ? "partially applied" : "effect" in value ? String(value.effect) : isFailure(value) ? "failed" : "completed"}`,
    ];
    if ("path" in value && typeof value.path === "string") lines.push(value.path);
    if ("target" in value && typeof value.target === "string")
      lines.push(`Target: ${value.target}`);
    if ("operations" in value && Array.isArray(value.operations))
      lines.push(...value.operations.map(formatOperationOutcome));
    else if ("errors" in value && Array.isArray(value.errors))
      lines.push(...value.errors.map(formatReceiptError));
    if ("error" in value) lines.push(formatReceiptError(value.error));
    if (
      isFailure(value) &&
      "completed" in value &&
      Array.isArray(value.completed) &&
      value.completed.length > 0
    )
      lines.push(`Affected resources: ${value.completed.join(", ")}`);
    return [text(lines.join("\n")), ...("metadata" in value ? renderValue(value.metadata) : [])];
  }
  if (typeof value === "string") return [text(value)];
  if (
    value !== null &&
    typeof value === "object" &&
    "content" in value &&
    isAgentContent(value.content)
  ) {
    return value.content.map((block) =>
      block.type === "custom" ? text(JSON.stringify(block)) : block,
    );
  }
  return [text(value === undefined ? "undefined" : JSON.stringify(value, null, 2))];
}

function asReadResult(value: unknown): ReadToolResult | undefined {
  if (
    value === null ||
    typeof value !== "object" ||
    !("source" in value) ||
    typeof value.source !== "string" ||
    !("lines" in value) ||
    !Array.isArray(value.lines) ||
    !("content" in value) ||
    !isAgentContent(value.content)
  )
    return undefined;
  return { content: renderValue(value), details: value as ReadResultDetails };
}

function formatOperationOutcome(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const index = "index" in value ? Number(value.index) + 1 : "?";
  const kind = "kind" in value ? String(value.kind) : "operation";
  const status = "status" in value ? String(value.status) : "unknown";
  const detail =
    "warning" in value
      ? ` — ${formatReceiptError(value.warning)}`
      : "error" in value
        ? ` — ${formatReceiptError(value.error)}`
        : "";
  return `${index}. ${kind}: ${status}${detail}`;
}

function formatReceiptError(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  const source = "source" in value ? String(value.source) : undefined;
  const code = "code" in value ? String(value.code) : "OPERATION_FAILED";
  const message = "message" in value ? String(value.message) : "The operation failed.";
  return [source, formatApplyFailure(code, message)].filter(Boolean).join(": ");
}

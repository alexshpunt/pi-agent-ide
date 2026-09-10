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
  if (!truncateHead(full).truncated) return { content, level: "full" };
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
      return { content: compact, level: "compact", temporarySource };
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
function isFailure(value: unknown): boolean {
  return value !== null && typeof value === "object" && "ok" in value && value.ok === false;
}
function formatError(error: unknown): string {
  const failure = serializeApplyError(error);
  return `${failure.code}: ${failure.message}`;
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
      `${value.operation}: ${"effect" in value ? String(value.effect) : isFailure(value) ? "failed" : "completed"}`,
    ];
    if ("path" in value && typeof value.path === "string") lines.push(value.path);
    if ("target" in value && typeof value.target === "string")
      lines.push(`Target: ${value.target}`);
    if ("errors" in value && Array.isArray(value.errors))
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

function formatReceiptError(value: unknown): string {
  if (value === null || typeof value !== "object") return String(value);
  return [
    "source" in value ? String(value.source) : undefined,
    "code" in value ? String(value.code) : undefined,
    "message" in value ? String(value.message) : undefined,
  ]
    .filter(Boolean)
    .join(": ");
}

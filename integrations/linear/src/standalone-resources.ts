import { createHash } from "node:crypto";
import {
  ResourceError,
  type AgentContent,
  type Resource,
  type ResourceResolver,
} from "pi-agent-ide/api/resource";
import type { AgentDocumentation } from "pi-agent-ide/api/documentation";
import type { FileOperationResolver } from "pi-agent-ide/api/text-editor";
import type { LinearSemanticHandler } from "./semantic.ts";
import { createLinearSearchResolver } from "./search.ts";
import { searchAxiObjects } from "./object-search.ts";
import { parseTextAddress } from "./text-address.ts";
import { parseLinearFieldAddress } from "./fields.ts";
import { linearOperationRoute } from "./operation-routes.ts";

interface Context {
  readonly cwd: string;
  readonly signal?: AbortSignal;
}
interface Span {
  readonly from: number;
  readonly to: number;
}
export interface StandaloneInput {
  readonly path: string;
  readonly content?: string;
  readonly text?: string;
  readonly start?: string;
  readonly end?: string;
  readonly anchor?: string;
  readonly before?: boolean;
  readonly target?: string;
  readonly separation?: "line" | "blank-line";
}
export interface StandaloneReadInput {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly views?: readonly string[];
}
export interface StandaloneResult {
  readonly content: AgentContent;
  readonly details: Record<string, unknown>;
  readonly isError?: boolean;
}
export interface StandaloneOptions {
  readonly resolvers: readonly ResourceResolver[];
  readonly write: readonly LinearSemanticHandler[];
  readonly insert: readonly LinearSemanticHandler[];
  readonly fileOperations: readonly FileOperationResolver[];
  readonly guides: readonly AgentDocumentation[];
  readonly ownsWriteAction?: (source: string) => boolean;
  readonly run?: <T>(context: Context, execute: () => Promise<T>) => Promise<T>;
}
const maximumBytes = 2 * 1024 * 1024;
const lineHash = (line: string) =>
  createHash("sha256").update(line).digest("hex").slice(0, 8).toUpperCase();
const linesOf = (content: string) => content.match(/[^\n]*\n|[^\n]+$/gu) ?? [""];
function offsets(content: string) {
  let offset = 0;
  return linesOf(content).map((text) => {
    const from = offset;
    offset += text.length;
    return { from, to: offset, text };
  });
}
function fail(code: string, source: string): never {
  throw new ResourceError(code, source, "not-applied");
}
function textOnly(content: AgentContent, source: string): string {
  if (content.some((block) => block.type !== "text")) fail("LINEAR_NON_TEXT_RESOURCE", source);
  const text = content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  if (Buffer.byteLength(text) > maximumBytes) fail("LINEAR_CONTENT_TOO_LARGE", source);
  return text;
}
function result(
  text: string,
  details: Record<string, unknown> = {},
  isError = false,
): StandaloneResult {
  return { content: [{ type: "text", text }], details, ...(isError ? { isError: true } : {}) };
}
function dangerousOutcome(data: Readonly<Record<string, unknown>>) {
  if (data.kind === "linear-graphql" && typeof data.ok === "boolean") return !data.ok;
  const attachment = (data.upload as { attachment?: { effect?: string } } | undefined)?.attachment;
  return (
    data.error !== undefined ||
    (typeof data.effect === "string" && data.effect !== "applied") ||
    (attachment !== undefined && attachment.effect !== "applied")
  );
}
/** A bounded standalone host for the same Linear resources and semantic mutations used by the IDE. */
export function createStandaloneResources(options: StandaloneOptions) {
  async function resolve(source: string, context: Context): Promise<Resource> {
    context.signal?.throwIfAborted();
    if (!source.startsWith("linear://") && !source.startsWith("https://linear.app/"))
      fail("LINEAR_INVALID_URL", source);
    for (const resolver of options.resolvers) {
      const attempt = await resolver.tryResolve(source, context);
      if (attempt.kind === "failed") throw attempt.error;
      if (attempt.kind === "resolved") return attempt.resource;
    }
    return fail("LINEAR_RESOURCE_UNAVAILABLE", source);
  }
  async function readText(source: string, cwd: string, signal?: AbortSignal) {
    const resource = await resolve(source, { cwd, signal });
    if (!resource.read) fail("LINEAR_READ_UNAVAILABLE", source);
    return {
      source: resource.source,
      content: textOnly(await resource.read({ signal }), source),
      complete: true,
    };
  }
  async function read(input: StandaloneReadInput, context: Context): Promise<StandaloneResult> {
    if (input.views?.some((view) => view !== "anchors"))
      fail("LINEAR_STANDALONE_VIEW_UNSUPPORTED", input.path);
    let source = input.path;
    let content: AgentContent;
    if (source === "docs:")
      content = [
        {
          type: "text",
          text: options.guides
            .map((guide) => `- docs:${guide.id}: ${guide.description}`)
            .join("\n"),
        },
      ];
    else if (source.startsWith("docs:")) {
      const guide = options.guides.find((guide) => source === `docs:${guide.id}`);
      if (!guide) fail("LINEAR_GUIDE_NOT_FOUND", source);
      content = [{ type: "text", text: guide.markdown }];
    } else {
      const resource = await resolve(source, context);
      source = resource.source;
      if (!resource.read) fail("LINEAR_READ_UNAVAILABLE", source);
      content = await resource.read({ signal: context.signal });
    }
    if (content.some((block) => block.type !== "text")) return { content, details: { source } };
    const text = textOnly(content, source);
    const lines = offsets(text);
    const offset = input.offset ?? 1;
    const start = offset < 0 ? Math.max(0, lines.length + offset) : Math.max(0, offset - 1);
    let end = Math.min(lines.length, start + (input.limit ?? 150));
    let bytes = 0;
    for (let index = start; index < end; index++) {
      bytes += Buffer.byteLength(lines[index].text);
      if (bytes > 30_000) {
        end = index;
        break;
      }
    }
    if (start < lines.length && end === start && (input.limit ?? 150) !== 0)
      fail("LINEAR_LINE_TOO_LARGE", source);
    const display = lines
      .slice(start, end)
      .map((line, index) =>
        input.views?.includes("anchors")
          ? `${index + start + 1}#${lineHash(line.text.replace(/\r?\n$/u, ""))} ${line.text}`
          : line.text,
      )
      .join("");
    const remaining =
      end < lines.length
        ? `\n\n[More lines. Use linear_read with path ${JSON.stringify(source)}, offset ${end + 1}.]`
        : "";
    return result(display + remaining, {
      source,
      startLine: start + 1,
      endLine: end,
      totalLines: lines.length,
      complete: start === 0 && end === lines.length,
    });
  }
  const searchResolver = createLinearSearchResolver(searchAxiObjects, readText);
  async function search(
    input: {
      path: string;
      query: string;
      limit?: number;
      caseSensitive?: boolean;
      wholeWord?: boolean;
    },
    context: Context,
  ): Promise<StandaloneResult> {
    const attempt = await searchResolver.tryResolve(input, context);
    if (attempt.kind === "failed") throw attempt.error;
    if (attempt.kind !== "resolved") fail("LINEAR_INVALID_SEARCH_SCOPE", input.path);
    const formatted = await searchResolver.format(attempt.payload, context);
    return result(
      formatted.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n"),
      { search: formatted.details },
    );
  }
  function selection(content: string, anchor: string, source: string): Span {
    const line = /^(\d+)#([A-F0-9]{8})$/u.exec(anchor);
    if (line) {
      const index = Number(line[1]) - 1;
      const selected = index >= 0 ? offsets(content).at(index) : undefined;
      if (!selected || lineHash(selected.text.replace(/\r?\n$/u, "")) !== line[2])
        fail("LINEAR_ANCHOR_STALE", source);
      return selected;
    }
    if (!anchor) fail("LINEAR_ANCHOR_REQUIRED", source);
    const from = content.indexOf(anchor);
    if (from < 0 || content.indexOf(anchor, from + 1) >= 0)
      fail("LINEAR_ANCHOR_NOT_UNIQUE", source);
    const to = from + anchor.length;
    for (const point of [from, to]) {
      const previous = content.charCodeAt(point - 1);
      const next = content.charCodeAt(point);
      if (
        (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) ||
        (previous === 13 && next === 10)
      )
        fail("LINEAR_INVALID_TEXT_BOUNDARY", source);
    }
    return { from, to };
  }
  function lineExtent(content: string, span: Span): Span {
    const first = span.from === 0 ? 0 : content.lastIndexOf("\n", span.from - 1) + 1;
    const last =
      span.to > span.from && content[span.to - 1] === "\n"
        ? span.to
        : content.indexOf("\n", span.to);
    return {
      from: first,
      to:
        last < 0
          ? content.length
          : last === span.to && span.to > span.from && content[span.to - 1] === "\n"
            ? last
            : last + 1,
    };
  }
  let pending: Promise<unknown> = Promise.resolve();
  async function apply(
    operation: string,
    input: StandaloneInput,
    context: Context,
  ): Promise<StandaloneResult> {
    context.signal?.throwIfAborted();
    if (
      ["copy", "move", "delete"].includes(operation) &&
      input.start === undefined &&
      input.end === undefined
    ) {
      for (const resolver of options.fileOperations) {
        const receipt = await resolver(operation as "copy" | "move" | "delete", input, context);
        if (!receipt) continue;
        return result(
          `Linear ${operation}: ${receipt.effect}.\nSource: ${receipt.path ?? input.path}${receipt.target ? `\nTarget: ${receipt.target}` : ""}${receipt.error ? `\n${receipt.error.code}` : ""}\nRead again before another change. Never replay an uncertain operation.`,
          { ...receipt },
          !receipt.ok,
        );
      }
      fail("LINEAR_OPERATION_UNAVAILABLE", input.path);
    }
    const handlers =
      operation === "write" ? options.write : operation === "insert" ? options.insert : [];
    const { anchor, before, ...insertInput } = input;
    const semanticInput =
      operation !== "insert"
        ? input
        : before === true
          ? { ...insertInput, before: anchor ?? "" }
          : anchor === undefined
            ? insertInput
            : { ...insertInput, after: anchor };
    const handler = handlers.find((handler) => handler.matches(semanticInput));
    const text = parseTextAddress(input.path);
    const field = parseLinearFieldAddress(input.path);
    const creation =
      text?.kind === "create-document" ||
      text?.kind === "create-comment" ||
      field?.id === "new" ||
      field?.facet === "new";
    const route =
      field &&
      linearOperationRoute(field.kind, "write", field.facet === "fields" ? undefined : field.facet);
    const action =
      !!route?.facet || (operation === "write" && options.ownsWriteAction?.(input.path) === true);
    // Creations and typed action requests are validated by their backend schema; their card is not writable text.
    let current = "";
    let resource: Resource | undefined;
    if (!creation && !action && !(operation === "insert" && handler)) {
      resource = await resolve(input.path, context);
      if (!resource.read) fail("LINEAR_READ_UNAVAILABLE", input.path);
      current = textOnly(await resource.read({ signal: context.signal }), input.path);
    }
    if (handler) {
      const receipt = await handler.execute(
        { ...context, sourceDocument: { content: current } },
        semanticInput,
      );
      return result(
        receipt.summary,
        { metadata: { semanticAction: receipt.data } },
        dangerousOutcome(receipt.data),
      );
    }
    if (!resource?.write) fail("LINEAR_READ_ONLY", input.path);
    let span: Span;
    let insertion: string;
    if (operation === "write") {
      span = { from: 0, to: current.length };
      if (input.content === undefined) fail("LINEAR_INVALID_INPUT", input.path);
      insertion = input.content;
    } else {
      const anchor = operation === "insert" ? input.anchor : input.start;
      if (!anchor) fail("LINEAR_ANCHOR_REQUIRED", input.path);
      span = selection(current, anchor, input.path);
      if (input.end !== undefined) {
        const last = selection(current, input.end, input.path);
        if (last.to < span.from) fail("LINEAR_RANGE_REVERSED", input.path);
        span = lineExtent(current, { from: span.from, to: last.to });
      }
      if (operation === "insert") {
        span = lineExtent(current, span);
        const point = input.before ? span.from : span.to;
        const separator = current.includes("\r\n") ? "\r\n" : "\n";
        if (input.text === undefined) fail("LINEAR_INVALID_INPUT", input.path);
        insertion = input.text.replace(/\r?\n/gu, separator);
        if (point > 0 && current[point - 1] !== "\n" && !insertion.startsWith(separator))
          insertion = separator + insertion;
        if (point < current.length && !insertion.endsWith(separator)) insertion += separator;
        if (input.separation === "blank-line") {
          if (
            point > 0 &&
            !current.slice(0, point).endsWith(separator + separator) &&
            !insertion.startsWith(separator)
          )
            insertion = separator + insertion;
          if (
            point < current.length &&
            !current.slice(point).startsWith(separator) &&
            !insertion.endsWith(separator + separator)
          )
            insertion += separator;
        }
        span = { from: point, to: point };
      } else {
        const separator = current.includes("\r\n") ? "\r\n" : "\n";
        if (operation !== "delete" && input.text === undefined)
          fail("LINEAR_INVALID_INPUT", input.path);
        insertion = operation === "delete" ? "" : (input.text ?? "").replace(/\r?\n/gu, separator);
        const linewise = input.end !== undefined || /^\d+#[A-F0-9]{8}$/u.test(anchor);
        if (linewise && insertion && span.to < current.length && !insertion.endsWith(separator))
          insertion += separator;
      }
    }
    const next = current.slice(0, span.from) + insertion + current.slice(span.to);
    if (Buffer.byteLength(next) > maximumBytes) fail("LINEAR_CONTENT_TOO_LARGE", input.path);
    await resource.write([{ type: "text", text: next }], { signal: context.signal });
    return result(
      `Linear ${operation}: applied.\nRead: ${resource.source}\nRead again before another edit.`,
      { source: resource.source, effect: "applied" },
    );
  }
  function mutate(operation: string, input: StandaloneInput, context: Context) {
    const call = pending.then(() => apply(operation, input, context));
    pending = call.catch(() => undefined);
    return call;
  }
  const guarded = <T>(context: Context, execute: () => Promise<T>) =>
    options.run ? options.run(context, execute) : execute();
  return {
    read: (...args: Parameters<typeof read>) =>
      args[0].path.startsWith("docs:") ? read(...args) : guarded(args[1], () => read(...args)),
    readText: (...args: Parameters<typeof readText>) =>
      guarded({ cwd: args[1], signal: args[2] }, () => readText(...args)),
    search: (...args: Parameters<typeof search>) => guarded(args[1], () => search(...args)),
    mutate: (...args: Parameters<typeof mutate>) => guarded(args[2], () => mutate(...args)),
  };
}

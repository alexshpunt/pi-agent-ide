import { createHash } from "node:crypto";
import path from "node:path";
import type {
  MessageEndEvent,
  MessageEndEventResult,
  ExtensionAPI,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import {
  connectResultImages,
  connectResultTargets,
  resultValueId,
  TempResourceStore,
} from "pi-agent-resource";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_PROTOCOL, READ_API_VERSION } from "pi-agent-read/api/plugin-protocol";
import { limitIdeOutput } from "./output-limits.ts";
import { nullableValueSchema, scriptValueOf } from "./script-values/index.ts";
import type { ImageBlock } from "./script-values/read.ts";
import { batchOperations, CodemodeCallLedger, fileEffects } from "./script-values/failures.ts";
import { envelopePattern, resultReference } from "./script-values/result-reference.ts";

/** Longest source label in the Codemode failure block. */
const maxLabelLength = 200;

const sourceFields: Record<string, readonly string[]> = {
  read: ["path"],
  search: ["path"],
  ast_search: ["path"],
  lsp_search: ["path"],
  file_search: ["path"],
  replace: ["path"],
  insert: ["path"],
  delete: ["path"],
  write: ["path"],
  copy: ["path", "target"],
  move: ["path", "target"],
  undo: ["file"],
  diff: ["before", "after"],
};

/** What a failed call of a tool without source fields names in the Codemode failure block. */
const labelFields: Record<string, readonly string[]> = {
  bash: ["command"],
  powershell: ["command"],
  remote_bash: ["command"],
  remote_powershell: ["command"],
  debug: ["program"],
  stage: ["file"],
  unstage: ["file"],
};

/** The sources a call names, as its title shows them; enveloped results become `RESULT#<uuid>`. */
function sourceLabel(name: string, input: Record<string, unknown>): string | undefined {
  const labels = (field: unknown): string[] => {
    if (Array.isArray(field)) return field.flatMap(labels);
    const id = resultValueId(field);
    if (id !== undefined) return labels(id);
    if (field !== null && typeof field === "object" && "path" in field) return labels(field.path);
    if (typeof field !== "string" || field === "") return [];
    // One line per entry: a multi-line command is shown on one line.
    const label = resultReference(field) ?? field.replaceAll(/\s+/gu, " ");
    return [label.length > maxLabelLength ? `${label.slice(0, maxLabelLength)}…` : label];
  };
  // Tools that other modules register through the IDE, such as provider edits, name `path`.
  const fields = labelFields[name] ?? sourceFields[name] ?? ["path"];
  // Several sources of one field, such as a path list, are a list; a target follows an arrow.
  const shown = fields
    .map((field) => labels(input[field]).join(", "))
    .filter((label) => label !== "");
  return shown.length === 0 ? undefined : shown.join(" → ");
}
/** A local path inside the workspace relative to it, as scripts usually name it. */
function displayPath(source: string, cwd: string): string {
  const root = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  return source.startsWith(root) && source.length > root.length
    ? source.slice(root.length)
    : source;
}
/** Keep tool records private while strings carry registered composition references. */
export function createIdeTextResults(
  pi: ExtensionAPI,
  options: { readonly resourceOutput?: boolean; readonly promptSection?: string } = {},
) {
  const store = connectResultTargets(pi);
  const resultImages = connectResultImages(pi);
  const names = new Set<string>();
  const outputs = new TempResourceStore();
  const saveFullOutput = (text: string) =>
    options.resourceOutput ? outputs.save(text) : outputs.saveFile(text);
  const contextErrors = new Map<
    string,
    { source: string; content: Promise<AgentToolResult<unknown>["content"]> }
  >();
  const signature = (content: AgentToolResult<unknown>["content"]) =>
    createHash("sha256").update(JSON.stringify(content)).digest("hex");
  const limitError = async (id: string, content: AgentToolResult<unknown>["content"]) => {
    const source = signature(content);
    const cached = contextErrors.get(id);
    if (cached && (cached.source === source || signature(await cached.content) === source))
      return cached.content;
    const limited = limitIdeOutput(content, "", saveFullOutput).then((output) => [
      {
        type: "text" as const,
        text: output.text + (output.notices.length ? `\n\n${output.notices.join("\n")}` : ""),
      },
      ...output.images,
    ]);
    contextErrors.set(id, { source, content: limited });
    return limited;
  };
  // Read core owns deferred registration and reports setup failures.
  void connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "ide-output-retention",
    setup(api) {
      api.setOutputSaver(saveFullOutput);
      if (options.resourceOutput)
        api.addResolver({
          priority: -1000,
          resolver: {
            id: "ide-output-retention",
            async tryResolve(source, context) {
              const result = await outputs.resolver.tryResolve(source, context);
              return result.kind === "failed" ? { kind: "not-handled" } : result;
            },
          },
        });
    },
  });
  pi.on("session_shutdown", () => outputs.dispose());
  const on: ExtensionAPI["on"] = (event, handler) => {
    // The SDK overloads describe event/handler pairs; forwarding keeps the original pair.
    if (event === "message_end") {
      const messageHandler = handler as ExtensionHandler<MessageEndEvent, MessageEndEventResult>;
      return pi.on("message_end", async (messageEvent, context) => {
        const result = await messageHandler(messageEvent, context);
        const message = result?.message ?? messageEvent.message;
        if (
          message.role !== "toolResult" ||
          !message.isError ||
          !names.has(message.toolName) ||
          message.content.some(
            (block) => block.type === "text" && block.text.startsWith("<system-result"),
          )
        )
          return result;
        return {
          ...result,
          message: { ...message, content: await limitError(message.toolCallId, message.content) },
        };
      });
    }
    const toolCallHandler = handler as ExtensionHandler<ToolCallEvent, ToolCallEventResult>;
    if (event !== "tool_call") return pi.on(event as "tool_call", toolCallHandler);
    return pi.on("tool_call", async (call, context) => {
      const ide = names.has(call.toolName);
      // A refused IDE call runs no further IDE hooks, as if the refusal had blocked it.
      if (ide && refusals.has(call.toolCallId)) return;
      const result = await toolCallHandler(call, context);
      if (!result?.block || !ide || result.terminate === true) return result;
      // Refuse in execution instead of blocking: a refused call is a failed IDE call, which
      // resolves to null in Codemode. Pi rejects blocked calls before any tool runs.
      const limited = await limitIdeOutput(
        [{ type: "text", text: result.reason ?? "Tool execution was blocked" }],
        "",
        saveFullOutput,
      );
      refusals.set(
        call.toolCallId,
        limited.text + (limited.notices.length ? `\n\n${limited.notices.join("\n")}` : ""),
      );
      return;
    });
  };
  const refusals = new Map<string, string>();
  const labels = new Map<string, string | undefined>();
  const ledger = new CodemodeCallLedger();
  /**
   * Nested IDE calls whose script value is null: failed calls, and edits that select no text.
   * Their value becomes null when their execution ends.
   */
  const nullNested = new Set<string>();
  const parents = new Map<string, string>();
  const images = new Map<string, ImageBlock[]>();
  /** Forget the calls of the last agent run. */
  const clearCalls = () => {
    refusals.clear();
    labels.clear();
    ledger.clear();
    nullNested.clear();
  };
  const clear = () => {
    parents.clear();
    images.clear();
    contextErrors.clear();
    clearCalls();
  };
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);
  pi.on("agent_end", clearCalls);
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections[options.promptSection ?? "ide_results"] =
      "Direct IDE calls return readable text. In Codemode, search, ast_search and lsp_search return { result, hasMatches, complete }; pass its result string to other tools for composition. file_search returns every matching path as a string array unless you set limit; semantic_search returns its files in rank order. Terminal tools return { output, exit_code, truncated, full_output_path, wall_time_seconds, session }; a non-zero exit_code is a value, not a failure. Diff returns the complete unified diff, or \"\" when the sources are equal. An image Read returns an image block: show it with image(), pass it to models.classify() images, and pass its note string to other tools. Successful text Reads and other text tools return strings. Replace, insert, write, copy, move and undo return the RESULT#<uuid> id of the text they produced, or null when they select no text, such as a directory copy; delete returns null. Pass an edit's id to the next tool's source parameter. A failed IDE call returns null (a resource provider's action keeps its receipt object) and the script continues; the Codemode result lists every failed call with its reason and recovery steps. Calls Pi itself rejects, such as invalid arguments or calls blocked by other extensions, still throw. The leading system-result envelope is an internal reference, not file content; do not edit it. Compose tools by passing the unchanged result string to a source parameter. Outside Codemode, pass the same text or its UUID. Store/load preserves results within the session. Use returned anchors to choose individual selections. Changed snapshots and previous sessions cannot be reused.";
  });
  pi.on("tool_execution_start", (event) => {
    if (event.parentToolCallId !== undefined)
      parents.set(event.toolCallId, parents.get(event.parentToolCallId) ?? event.parentToolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    if (!nullNested.delete(event.toolCallId)) return;
    // Pi drops a null structuredContent that a tool_result hook returns, because the agent loop
    // merges it with `??`. It hands this same result object to the calling script after the
    // event, so the null value is set here.
    const result: unknown = event.result;
    if (result !== null && typeof result === "object")
      Object.assign(result, { structuredContent: null });
  });
  on("tool_call", (event, context) => {
    if (!names.has(event.toolName)) return;
    labels.set(event.toolCallId, sourceLabel(event.toolName, event.input));
    const input: Record<string, unknown> = { ...event.input };
    try {
      for (const field of sourceFields[event.toolName] ?? []) {
        const value = input[field];
        if (value === undefined) continue;
        if (
          event.toolName === "diff" &&
          resultValueId(value) === undefined &&
          value !== null &&
          typeof value === "object" &&
          "path" in value
        ) {
          input[field] = { ...value, path: store.source(value.path, context.cwd, true) };
        } else {
          const source = store.source(
            value,
            context.cwd,
            event.toolName === "read"
              ? true
              : ["write", "insert", "delete"].includes(event.toolName)
                ? "live"
                : false,
          );
          if (event.toolName === "read" && Array.isArray(source)) {
            const selected = store.resolve(source, context.cwd);
            input[field] = store.register(selected.targets, context.cwd, selected.complete);
          } else input[field] = source;
        }
      }
      for (const field of ["text", "content"]) {
        const value = input[field];
        if (
          typeof value === "string" &&
          (value.trimStart().startsWith("<system-result") ||
            /<system-result\b[^>]*><uuid>[a-f\d-]{36}<\/uuid><\/system-result>/iu.test(value))
        ) {
          return {
            block: true,
            reason: "A system result reference is not file content. Do not insert it into a file.",
          };
        }
      }
      Object.assign(event.input, input);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });
  const registerTool: ExtensionAPI["registerTool"] = (definition) => {
    names.add(definition.name);
    const publicDefinition = {} as typeof definition;
    const descriptors = Object.getOwnPropertyDescriptors(definition);
    // Scripts get the tool's declared value, or null when the call failed. Private records stay hidden.
    descriptors.outputSchema = {
      value: nullableValueSchema(scriptValueOf(definition.name)),
      enumerable: true,
      configurable: true,
      writable: true,
    };
    const execute: typeof definition.execute = async (...args) => {
      const refusal = refusals.get(args[0]);
      if (refusal !== undefined) {
        refusals.delete(args[0]);
        // A refusal has no tool details, like a call that Pi blocks.
        return { content: [{ type: "text", text: refusal }], details: {} as never, isError: true };
      }
      // A Read issued by another tool, such as a Codemode script, returns its whole text there.
      const limitText = !(definition.name === "read" && parents.has(args[0]));
      const result = await definition.execute(...args).catch(async (error: unknown) => {
        const limited = await limitIdeOutput(
          [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          "",
          saveFullOutput,
        );
        if (limited.notices.length === 0) throw error;
        throw new Error(limited.text + `\n\n${limited.notices.join("\n")}`, { cause: error });
      });
      const limited = await limitIdeOutput(
        result.content,
        outputNotices(result.details),
        saveFullOutput,
        { limitText },
      );
      const text = limited.text + limited.metadataSuffix;
      return {
        ...result,
        content: [
          {
            type: "text",
            text: text + (limited.notices.length ? `\n\n${limited.notices.join("\n")}` : ""),
          },
          ...limited.images,
        ],
      };
    };
    descriptors.execute = { value: execute, enumerable: true, configurable: true, writable: true };
    const render = definition.renderCall;
    if (render) {
      const renderCall: typeof render = (args, theme, context) =>
        render(displaySources(definition.name, args), theme, context);
      descriptors.renderCall = {
        value: renderCall,
        enumerable: true,
        configurable: true,
        writable: true,
      };
    }
    const renderResult = definition.renderResult;
    if (renderResult) {
      const renderer: typeof renderResult = (result, options, theme, context) =>
        renderResult(
          {
            ...result,
            content: result.content.map((block) =>
              block.type === "text"
                ? {
                    ...block,
                    text: block.text.replace(envelopePattern, ""),
                  }
                : block,
            ),
          },
          options,
          theme,
          context,
        );
      descriptors.renderResult = {
        value: renderer,
        enumerable: true,
        configurable: true,
        writable: true,
      };
    }
    Object.defineProperties(publicDefinition, descriptors);
    pi.registerTool(publicDefinition);
  };
  const finalize = () => {
    // Validation can skip tool hooks, and later guards can replace an already bounded reason.
    // Limit the actual unpublished error at the provider boundary; keep saved records unchanged.
    pi.on("context", async (event) => ({
      messages: await Promise.all(
        event.messages.map(async (message) => {
          if (
            message.role !== "toolResult" ||
            !message.isError ||
            !names.has(message.toolName) ||
            message.content.some(
              (block) => block.type === "text" && block.text.startsWith("<system-result"),
            )
          )
            return message;
          return {
            ...message,
            content: await limitError(message.toolCallId, message.content),
          };
        }),
      ),
    }));
    pi.on("tool_result", async (event, context) => {
      if (event.toolName === "codemode") {
        store.refreshAll();
        // A script that showed a nested image with image() must not receive it a second time.
        const shown = new Set(
          event.content.flatMap((block) => (block.type === "image" ? [block.data] : [])),
        );
        const generated = (images.get(event.toolCallId) ?? []).filter(
          (block) => !shown.has(block.data),
        );
        images.delete(event.toolCallId);
        for (const [child, parent] of parents)
          if (parent === event.toolCallId) parents.delete(child);
        const metadata = event.content.filter(
          (block) => block.type === "text" && block.text.startsWith("\n\n---\n\n# Guide:"),
        );
        ledger.recordBatch(
          event.toolCallId,
          batchOperations(event.details, (source) => displayPath(source, context.cwd)),
        );
        const failures = ledger.take(event.toolCallId);
        const content = event.content.filter((block) => !metadata.includes(block));
        const limited = await limitIdeOutput([...content, ...generated], "", saveFullOutput);
        // Whether the script completed or threw, the result ends with its failed IDE calls, after
        // any guides, within its own output limit.
        const block =
          failures === undefined
            ? undefined
            : await limitIdeOutput([{ type: "text", text: failures }], "", saveFullOutput);
        return {
          content: [
            ...(limited.textTruncated
              ? [{ type: "text" as const, text: limited.text }]
              : content.filter((block) => block.type === "text")),
            ...limited.images,
            ...(limited.notices.length
              ? [{ type: "text" as const, text: `\n\n${limited.notices.join("\n")}` }]
              : []),
            ...metadata,
            ...(block === undefined
              ? []
              : [
                  {
                    type: "text" as const,
                    text: `\n\n${block.text}${block.notices.length ? `\n\n${block.notices.join("\n")}` : ""}`,
                  },
                ]),
          ],
        };
      }
      if (!names.has(event.toolName)) return;
      const original = event.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const record = event.structuredContent;
      const outcome =
        record !== null && typeof record === "object" && "data" in record
          ? record
          : { status: event.isError ? "error" : "success", data: record };
      const data = outcome.data;
      const targetUnavailable =
        data !== null &&
        typeof data === "object" &&
        "effect" in data &&
        data.effect === "applied" &&
        "targetUnavailable" in data &&
        typeof data.targetUnavailable === "string"
          ? data.targetUnavailable
          : undefined;
      // A tool that already states the reason, such as Copy of a binary file, needs no second notice.
      const readable =
        targetUnavailable === undefined || original.includes(targetUnavailable)
          ? original
          : `${original}\n\nThis result has no verified text selection: ${targetUnavailable}\nRead/Search the file before the next edit; do not repeat the applied edit.`;
      const resources = resultResources(outcome);
      // An edit that changed only some files, or whose effect is unknown, failed as a whole.
      const failed = event.isError || outcome.status === "error" || outcome.status === "partial";
      const shown = store.publish(outcome, readable, context.cwd, resources);
      resultImages.keep(
        shown,
        context.cwd,
        event.toolName === "read" && !failed
          ? event.content.filter((block): block is ImageBlock => block.type === "image")
          : [],
      );
      const valueInput = {
        shown,
        outcome,
        content: event.content,
        details: event.details,
        cwd: context.cwd,
      };
      const scriptValue = scriptValueOf(event.toolName);
      // An error that scripts receive as a value, such as a non-zero exit code, is not a failure.
      const scriptFailed = failed && scriptValue.succeeded?.(valueInput) !== true;
      const projected = scriptFailed
        ? scriptValue.failed?.(valueInput)
        : scriptValue.project(valueInput);
      // A value that is the readable text stays off the record: Pi gives scripts the text then,
      // and direct results keep their shape.
      const value = projected === shown ? undefined : projected;
      const parent = parents.get(event.toolCallId);
      parents.delete(event.toolCallId);
      const label = labels.get(event.toolCallId);
      labels.delete(event.toolCallId);
      // Error text carries no envelope: a failed result selects nothing to compose with.
      const reason = readable.replace(envelopePattern, "");
      if (parent !== undefined) {
        const generated = event.content.filter((block) => block.type === "image");
        if (generated.length) images.set(parent, [...(images.get(parent) ?? []), ...generated]);
        ledger.record(
          parent,
          {
            id: event.toolCallId,
            tool: event.toolName,
            ...(label === undefined ? {} : { source: label }),
          },
          scriptFailed
            ? {
                reason,
                ...fileEffects(outcome, (source) => displayPath(source, context.cwd)),
              }
            : undefined,
        );
        if (value === null || (scriptFailed && value === undefined))
          nullNested.add(event.toolCallId);
      }
      return {
        content: [
          { type: "text" as const, text: failed ? reason : shown },
          ...event.content.filter((block) => block.type !== "text"),
        ],
        // Keep private records hidden; only the declared public script value survives. A direct
        // result is the text its edit id refers to, so it keeps its readable shape without the id.
        ...(value !== undefined &&
          value !== null &&
          (parent !== undefined || value !== resultReference(shown)) && {
            structuredContent: value,
          }),
      };
    });
  };
  return { api: { ...pi, on, registerTool }, finalize };
}

/** Read range notices belong to metadata, including reads spanning several resources. */
function outputNotices(details: unknown): string[] {
  if (details === null || typeof details !== "object") return [];
  const notices =
    "outputNotice" in details && typeof details.outputNotice === "string"
      ? [details.outputNotice]
      : [];
  if ("resources" in details && Array.isArray(details.resources)) {
    const resources: unknown[] = details.resources;
    for (const result of resources) {
      if (result !== null && typeof result === "object" && "details" in result)
        notices.push(...outputNotices(result.details));
    }
  }
  return notices;
}
/** Keep opaque result bodies out of user-facing tool titles without changing execution inputs. */
function displaySources<Args extends Record<string, unknown>>(name: string, args: Args): Args {
  const label = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(label);
    const id = resultValueId(value);
    if (id !== undefined) return id;
    if (value !== null && typeof value === "object" && "path" in value)
      return { ...value, path: label(value.path) };
    if (typeof value !== "string") return value;
    return resultReference(value) ?? value;
  };
  const shown = { ...args };
  for (const field of sourceFields[name] ?? [])
    Object.assign(shown, { [field]: label(args[field]) });
  return shown;
}

function resultResources(outcome: unknown): string[] {
  if (outcome === null || typeof outcome !== "object" || !("data" in outcome)) return [];
  const data = outcome.data;
  if (data === null || typeof data !== "object") return [];
  if ("resources" in data && Array.isArray(data.resources)) {
    const resources: unknown[] = data.resources;
    return resources.flatMap((resource) => resultResources({ data: resource }));
  }
  if ("files" in data && Array.isArray(data.files)) {
    const files: unknown[] = data.files;
    return files.flatMap((file) =>
      file !== null &&
      typeof file === "object" &&
      "source" in file &&
      typeof file.source === "string" &&
      /^(?:shell|debug):/u.test(file.source)
        ? [file.source]
        : [],
    );
  }
  return "source" in data && typeof data.source === "string" ? [data.source] : [];
}

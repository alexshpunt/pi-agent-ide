import { createHash } from "node:crypto";
import type {
  MessageEndEvent,
  MessageEndEventResult,
  ExtensionAPI,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "@earendil-works/pi-ai";
import { connectResultImages, connectResultTargets, TempResourceStore } from "pi-agent-resource";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_PROTOCOL, READ_API_VERSION } from "pi-agent-read/api/plugin-protocol";
import { limitIdeOutput } from "./output-limits.js";
import { searchFacts, searchFactsSchema } from "./search-facts.js";

const sourceFields: Record<string, readonly string[]> = {
  read: ["path"],
  search: ["path"],
  select: ["path"],
  replace: ["path"],
  insert: ["path"],
  delete: ["path"],
  write: ["path"],
  copy: ["path", "target"],
  move: ["path", "target"],
  undo: ["file"],
  diff: ["before", "after"],
};

/** Mutation tools whose resource providers may return a plain value to Codemode scripts. */
const providerValueTools = new Set(["write", "replace", "insert", "delete", "copy", "move"]);
/** Codemode resolves to the composition text, or to a provider's value when a semantic handler returns one. */
const providerValueSchema = {
  anyOf: [
    { type: "string" },
    {
      type: "object",
      description: "Value returned by a resource provider, such as a computer action outcome.",
      additionalProperties: true,
    },
  ],
};
const imageBlockSchema = {
  type: "object",
  properties: {
    type: { const: "image" },
    data: { type: "string" },
    mimeType: { type: "string" },
    note: { type: "string" },
  },
  required: ["type", "data", "mimeType", "note"],
};
/**
 * Codemode Read resolves to the composition text, or to native image blocks that image() and
 * models.classify() accept. The note carries the same readable, composable result text.
 */
const readValueSchema = {
  anyOf: [
    { type: "string" },
    imageBlockSchema,
    {
      type: "object",
      description: "Several images, such as sequence frames, in source order.",
      properties: {
        type: { const: "images" },
        note: { type: "string" },
        images: {
          type: "array",
          items: { type: "object", properties: imageBlockSchema.properties },
        },
      },
      required: ["type", "note", "images"],
    },
  ],
};
type ImageBlock = Extract<AgentToolResult<unknown>["content"][number], { type: "image" }>;
/** Native image script values for a successful Read; text reads keep their composition string. */
function readValue(
  content: AgentToolResult<unknown>["content"],
  note: string,
): JsonValue | undefined {
  const images = content
    .filter((block): block is ImageBlock => block.type === "image")
    .map(({ data, mimeType }) => ({ type: "image", data, mimeType }));
  if (images.length === 0) return undefined;
  const [first] = images;
  return images.length === 1 && first !== undefined
    ? { ...first, note }
    : { type: "images", note, images };
}
/** The value a semantic handler asked to return to scripts instead of text. */
function providerValue(details: unknown): JsonValue | undefined {
  const metadata = record(details) ? details.metadata : undefined;
  const action = record(metadata) ? metadata.semanticAction : undefined;
  const value = record(action) ? action.script : undefined;
  // Semantic handler results are plain JSON receipts; keep the declared object shape.
  return record(value) && !Array.isArray(value) ? (value as JsonValue) : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
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
      const result = await toolCallHandler(call, context);
      if (!result?.block || !names.has(call.toolName) || result.reason === undefined) return result;
      const limited = await limitIdeOutput(
        [{ type: "text", text: result.reason }],
        "",
        saveFullOutput,
      );
      return {
        ...result,
        reason: limited.text + (limited.notices.length ? `\n\n${limited.notices.join("\n")}` : ""),
      };
    });
  };
  const parents = new Map<string, string>();
  const images = new Map<string, ImageBlock[]>();
  const clear = () => {
    parents.clear();
    images.clear();
    contextErrors.clear();
  };
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections[options.promptSection ?? "ide_results"] =
      "Direct IDE calls return readable text. In Codemode, Search returns { result, hasMatches, complete }; pass its result string to other tools for composition. An image Read returns an image block: show it with image(), pass it to models.classify() images, and pass its note string to other tools. Other text results remain strings. The leading system-result envelope is an internal reference, not file content; do not edit it. Compose tools by passing the unchanged result string to a source parameter. Outside Codemode, pass the same text or its UUID. Store/load preserves results within the session. Use returned anchors to choose individual selections. Changed snapshots and previous sessions cannot be reused.";
  });
  pi.on("tool_execution_start", (event) => {
    if (event.parentToolCallId !== undefined)
      parents.set(event.toolCallId, parents.get(event.parentToolCallId) ?? event.parentToolCallId);
  });
  on("tool_call", (event, context) => {
    if (!names.has(event.toolName)) return;
    const input: Record<string, unknown> = { ...event.input };
    try {
      for (const field of sourceFields[event.toolName] ?? []) {
        const value = input[field];
        if (value === undefined) continue;
        if (
          event.toolName === "diff" &&
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
      if (
        event.toolName === "select" &&
        input.operation &&
        typeof input.operation === "object" &&
        "scopes" in input.operation
      ) {
        input.operation = {
          ...input.operation,
          scopes: store.source(input.operation.scopes, context.cwd),
        };
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
    // Keep readable composition strings except for explicitly declared public script values.
    delete descriptors.outputSchema;
    if (definition.name === "search")
      descriptors.outputSchema = {
        value: searchFactsSchema,
        enumerable: true,
        configurable: true,
        writable: true,
      };
    if (definition.name === "read")
      descriptors.outputSchema = {
        value: readValueSchema,
        enumerable: true,
        configurable: true,
        writable: true,
      };
    if (providerValueTools.has(definition.name))
      descriptors.outputSchema = {
        value: providerValueSchema,
        enumerable: true,
        configurable: true,
        writable: true,
      };
    const execute: typeof definition.execute = async (...args) => {
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
                    text: block.text.replace(
                      /^<system-result\b[^>]*><uuid>[a-f\d-]{36}<\/uuid><\/system-result>\n/u,
                      "",
                    ),
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
        const content = event.content.filter((block) => !metadata.includes(block));
        const limited = await limitIdeOutput([...content, ...generated], "", saveFullOutput);
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
      const readable =
        targetUnavailable === undefined
          ? original
          : `${original}\n\nThis result has no verified text selection: ${targetUnavailable}\nRead/Search the file before the next edit; do not repeat the applied edit.`;
      const resources = resultResources(outcome);
      const succeeded = !event.isError && outcome.status !== "error";
      const shown = store.publish(outcome, readable, context.cwd, resources);
      resultImages.keep(
        shown,
        context.cwd,
        event.toolName === "read" && succeeded
          ? event.content.filter((block): block is ImageBlock => block.type === "image")
          : [],
      );
      const value =
        event.toolName === "search" && succeeded
          ? searchFacts(outcome, shown)
          : event.toolName === "read"
            ? succeeded
              ? readValue(event.content, shown)
              : undefined
            : providerValue(event.details);
      const parent = parents.get(event.toolCallId);
      parents.delete(event.toolCallId);
      if (parent !== undefined) {
        const generated = event.content.filter((block) => block.type === "image");
        if (generated.length) images.set(parent, [...(images.get(parent) ?? []), ...generated]);
      }
      return {
        content: [
          { type: "text" as const, text: shown },
          ...event.content.filter((block) => block.type !== "text"),
        ],
        // Keep private records hidden; only the declared public script value survives.
        ...(value !== undefined && { structuredContent: value }),
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
    if (typeof value !== "string") return value;
    const uuid = /^<system-result\b[^>]*><uuid>([a-f\d-]{36})<\/uuid>/u.exec(value)?.[1];
    return uuid ? `RESULT#${uuid}` : value;
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

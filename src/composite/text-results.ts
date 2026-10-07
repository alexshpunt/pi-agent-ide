import type {
  ExtensionAPI,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { connectResultTargets, TempResourceStore } from "pi-agent-resource";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_PROTOCOL, READ_API_VERSION } from "pi-agent-read/api/plugin-protocol";
import { limitIdeOutput } from "./output-limits.js";

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

/** Keep tool records private while strings carry registered composition references. */
export function createIdeTextResults(pi: ExtensionAPI) {
  const store = connectResultTargets(pi);
  const names = new Set<string>();
  const outputs = new TempResourceStore();
  const saveFullOutput = (text: string) => outputs.saveFile(text);
  const boundedErrors = new Set<string>();
  const contextErrors = new Map<string, Promise<AgentToolResult<unknown>["content"]>>();
  // Read core owns deferred registration and reports setup failures.
  void connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "ide-output-retention",
    setup(api) {
      api.setOutputSaver(saveFullOutput);
    },
  });
  pi.on("session_shutdown", () => outputs.dispose());
  const on: ExtensionAPI["on"] = (event, handler) => {
    // The SDK overloads describe event/handler pairs; forwarding keeps the original pair.
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
      boundedErrors.add(call.toolCallId);
      return {
        ...result,
        reason: limited.text + (limited.notices.length ? `\n\n${limited.notices.join("\n")}` : ""),
      };
    });
  };
  const parents = new Map<string, string>();
  const images = new Map<
    string,
    Extract<AgentToolResult<unknown>["content"][number], { type: "image" }>[]
  >();
  const clear = () => {
    parents.clear();
    images.clear();
    boundedErrors.clear();
    contextErrors.clear();
  };
  pi.on("session_start", clear);
  pi.on("session_shutdown", clear);
  pi.on("before_agent_start", (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n<ide_results>\nIDE tools return readable text. The leading system-result envelope is an internal reference, not file content; do not edit it. Compose tools by passing the unchanged result to a source parameter. Outside Codemode, pass the same text or its UUID. Store/load preserves these strings within the session. Use returned anchors to choose individual selections. Changed snapshots and previous sessions cannot be reused.\n</ide_results>`,
  }));
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
    delete descriptors.outputSchema;
    const execute: typeof definition.execute = async (...args) => {
      const result = await definition.execute(...args).catch(async (error: unknown) => {
        const limited = await limitIdeOutput(
          [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          "",
          saveFullOutput,
        );
        boundedErrors.add(args[0]);
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
    // Host argument validation can fail before tool_call, execute and tool_result run.
    // Bound those unpublished errors at the provider boundary; keep saved records unchanged.
    pi.on("context", async (event) => ({
      messages: await Promise.all(
        event.messages.map(async (message) => {
          if (
            message.role !== "toolResult" ||
            !message.isError ||
            !names.has(message.toolName) ||
            boundedErrors.has(message.toolCallId) ||
            message.content.some(
              (block) => block.type === "text" && block.text.startsWith("<system-result"),
            )
          )
            return message;
          let content = contextErrors.get(message.toolCallId);
          if (content === undefined) {
            content = limitIdeOutput(message.content, "", saveFullOutput).then((limited) => [
              {
                type: "text" as const,
                text:
                  limited.text +
                  (limited.notices.length ? `\n\n${limited.notices.join("\n")}` : ""),
              },
              ...limited.images,
            ]);
            contextErrors.set(message.toolCallId, content);
          }
          return { ...message, content: await content };
        }),
      ),
    }));
    pi.on("tool_result", async (event, context) => {
      if (event.toolName === "codemode") {
        store.refreshAll();
        const generated = images.get(event.toolCallId) ?? [];
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
            {
              type: "text",
              text:
                limited.text + (limited.notices.length ? `\n\n${limited.notices.join("\n")}` : ""),
            },
            ...limited.images,
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
      const resources = resultResources(outcome);
      const shown = store.publish(outcome, original, context.cwd, resources);
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

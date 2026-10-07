import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { connectResultTargets } from "pi-agent-resource";

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
  const parents = new Map<string, string>();
  const images = new Map<
    string,
    Extract<AgentToolResult<unknown>["content"][number], { type: "image" }>[]
  >();
  const clear = () => {
    parents.clear();
    images.clear();
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
  pi.on("tool_call", (event, context) => {
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
    pi.on("tool_result", (event, context) => {
      if (event.toolName === "codemode") {
        store.refreshAll();
        const generated = images.get(event.toolCallId) ?? [];
        images.delete(event.toolCallId);
        for (const [child, parent] of parents)
          if (parent === event.toolCallId) parents.delete(child);
        return generated.length ? { content: [...event.content, ...generated] } : undefined;
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
      const shown = store.publish(outcome, readable, context.cwd, resources);
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
  return { api: { ...pi, registerTool }, finalize };
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectTipProvider, TIP_API_VERSION, TIP_PROTOCOL } from "#src/api/tips.js";
import { semanticEngine, type SemanticEngine } from "./engine.js";

/** Backend operations are project scoped; searches update the existing index. */
export interface SemanticBackend {
  available(cwd: string): Promise<boolean>;
  index(cwd: string, signal?: AbortSignal, onProgress?: (message: string) => void): Promise<void>;
  search(
    cwd: string,
    query: string,
    options: { path?: string; include?: string; exclude?: string },
    signal?: AbortSignal,
  ): Promise<string>;
}

export function createConfiguredSemanticExtension(
  backends: Record<SemanticEngine, SemanticBackend>,
  preference?: string,
) {
  try {
    const selected = semanticEngine(preference);
    return createSemanticExtension(backends[selected], selected === "vera" ? "Vera" : "ColGREP");
  } catch (error) {
    const invalid: SemanticBackend = {
      available: async () => false,
      index: async () => {
        throw error;
      },
      search: async () => {
        throw error;
      },
    };
    return createSemanticExtension(invalid, "configured");
  }
}
export function createSemanticExtension(
  backend: SemanticBackend,
  engine: "ColGREP" | "Vera" | "configured" = "ColGREP",
) {
  return async function registerSemanticSearch(pi: ExtensionAPI): Promise<void> {
    let exposure: "direct" | "hidden" | undefined;
    const publish = (next: "direct" | "hidden") => {
      if (next === exposure) return;
      exposure = next;
      pi.registerTool({
        name: "semantic_search",
        label: "semantic_search",
        exposure: next,
        namespace: { name: "ide_semantic_search", description: "Find project code by meaning." },
        description: `Use semantic_search to find indexed local project code by meaning. Results group ranked files with counts of retrieved distinct candidate ranges, not occurrence counts. Search again with path set to one file for approximate ranked ranges. Ranges are hints, not editable selections; read before editing.${engine === "Vera" ? " Scoped or filtered searches may omit relevant results because Vera can filter a limited candidate pool." : ""}`,
        promptSnippet: "Find indexed project code by meaning",
        parameters: Type.Object(
          {
            query: Type.String({
              minLength: 1,
              description: "Describe the code or behavior to find.",
            }),
            path: Type.Optional(
              Type.String({
                description:
                  "Local indexed file or directory within the project. A file returns approximate ranges.",
              }),
            ),
            include: Type.Optional(
              Type.String({ description: "Include glob list for local files." }),
            ),
            exclude: Type.Optional(
              Type.String({ description: "Exclude glob list for local files." }),
            ),
          },
          { additionalProperties: false },
        ),
        async execute(_id, params, signal, _onUpdate, context) {
          if (!(await backend.available(context.cwd)))
            throw new Error(
              "Semantic search is unavailable for this project. Run /semantic-index first.",
            );
          const result = await backend.search(
            context.cwd,
            params.query,
            { path: params.path, include: params.include, exclude: params.exclude },
            signal,
          );
          return { content: [{ type: "text", text: result }], details: {} };
        },
      });
      if (next === "hidden") {
        const active = pi.getActiveTools();
        if (active.includes("semantic_search"))
          pi.setActiveTools(active.filter((name) => name !== "semantic_search"));
      }
    };
    const refresh = async (cwd: string) => {
      let usable = false;
      try {
        usable = await backend.available(cwd);
      } catch {
        /* An optional backend must not block the IDE. */
      }
      publish(usable ? "direct" : "hidden");
      return usable;
    };
    await connectTipProvider(pi, {
      protocol: TIP_PROTOCOL,
      apiVersion: TIP_API_VERSION,
      id: "semantic-search",
      async getTip(context) {
        if (context.mode !== "tui" || !context.hasUI || (await backend.available(context.cwd)))
          return undefined;
        return {
          id: "semantic-search-v1",
          scope: "project",
          title: "Optional semantic code search",
          body: "Run /semantic-index to enable code search by meaning in this project. The first index downloads tools and a model and can take several minutes.",
        };
      },
    });
    pi.registerCommand("semantic-index", {
      description: `Prepare ${engine} and index this project for semantic code search`,
      async handler(args, context) {
        if (args.trim()) {
          context.ui.notify("Usage: /semantic-index", "warning");
          return;
        }
        context.ui.notify(
          `Preparing the ${engine} semantic search index. This can take several minutes.`,
          "info",
        );
        try {
          await backend.index(context.cwd, context.signal, (message) => {
            context.ui.notify(message.trim(), "info");
          });
          if (!(await refresh(context.cwd))) throw new Error("The completed index is not usable.");
          context.ui.notify(`${engine} semantic search index is ready.`, "info");
        } catch (error) {
          await refresh(context.cwd);
          context.ui.notify(
            `Semantic indexing failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      },
    });
    pi.on("session_start", async (_event, context) => {
      await refresh(context.cwd);
    });
    pi.on("before_agent_start", async (_event, context) => {
      await refresh(context.cwd);
    });
  };
}

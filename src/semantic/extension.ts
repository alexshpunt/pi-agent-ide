import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { connectTipProvider, TIP_API_VERSION, TIP_PROTOCOL } from "#src/api/tips.js";

/** Backend operations are project scoped; searches update the existing index. */
export interface SemanticBackend {
  available(cwd: string): Promise<boolean>;
  index(cwd: string, signal?: AbortSignal, onProgress?: (message: string) => void): Promise<void>;
  search(cwd: string, query: string, signal?: AbortSignal): Promise<string>;
}

export function createSemanticExtension(backend: SemanticBackend) {
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
        description:
          "Find code in the indexed local project by meaning. Results are paths and line ranges, not editable selections. Read a result before editing.",
        promptSnippet: "Find indexed project code by meaning",
        parameters: Type.Object(
          {
            query: Type.String({
              minLength: 1,
              description: "Describe the code or behavior to find.",
            }),
          },
          { additionalProperties: false },
        ),
        async execute(_id, params, signal, _onUpdate, context) {
          if (!(await backend.available(context.cwd)))
            throw new Error(
              "Semantic search is unavailable for this project. Run /semantic-index first.",
            );
          const result = await backend.search(context.cwd, params.query, signal);
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
      description: "Install ColGREP if needed and index this project for semantic code search",
      async handler(args, context) {
        if (args.trim()) {
          context.ui.notify("Usage: /semantic-index", "warning");
          return;
        }
        context.ui.notify(
          "Preparing the semantic search index. This can take several minutes.",
          "info",
        );
        try {
          await backend.index(context.cwd, context.signal, (message) => {
            if (
              message.startsWith("Downloading ColGREP") ||
              message.startsWith("Indexing project with ColGREP")
            )
              context.ui.notify(message.trim(), "info");
          });
          if (!(await refresh(context.cwd))) throw new Error("The completed index is not usable.");
          context.ui.notify("Semantic search index is ready.", "info");
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

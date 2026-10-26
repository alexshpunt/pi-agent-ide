import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { createSourceMappedTextReadHandler } from "pi-agent-ide/api/code-view";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import { createReadResultRenderer } from "pi-agent-read/api/rendering";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_POSITION_ANCHOR_KIND,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { AstScopeManager } from "./ast/manager.js";
import { astDoctorPlugin } from "./doctor-plugin.js";
import { createAstOutlineResolver } from "./outline-resolver.js";
import { createAstOverflowHandler, reduceAstReadOutput } from "./overflow-handler.js";
import { createAstScopePostReadHandler, createAstScopePresenter } from "./scope-handler.js";
import { createAstScopeAnchorResolver } from "./scope-resolver.js";
import { createAstSearchResolver } from "./search-resolver.js";
import { registerAstSearchTool, type AstSearchRuntime } from "./tool-ast-search.js";

const renderReadResult = createReadResultRenderer({ kind: "code-view", label: "AST" });

export default async function registerAst(pi: ExtensionAPI): Promise<void> {
  let resolveSearchApi!: (value: AstSearchRuntime) => void;
  const searchApi = new Promise<AstSearchRuntime>((resolve) => (resolveSearchApi = resolve));
  const manager = new AstScopeManager();
  const presenter = createAstScopePresenter(manager);

  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "ast",
    async setup(api) {
      api.addResolver({
        resolver: createAstOutlineResolver(undefined, async (source, context) => {
          const result = await api.read({ path: source }, context, "script");
          if (result.isError === true)
            throw new Error(
              result.details.failure?.message ??
                "Could not acquire an owned text snapshot for the AST outline.",
            );
          if (result.script?.kind !== "text")
            throw new Error("AST outlines require an owned text snapshot.");
          return {
            source: result.script.source,
            lines: result.script.lines.map((line) => line.content),
          };
        }),
        renderResult: renderReadResult,
      });
      api.addHandler({
        stage: "read",
        when: { resolvedBy: "ast", contentKind: "text" },
        handler: createSourceMappedTextReadHandler(),
      });
      api.addView({ view: "ast", presenter });
      const overflow = createAstOverflowHandler();
      api.addOutputReducer(reduceAstReadOutput);
      const scopes = createAstScopePostReadHandler();
      api.addHandler({
        stage: "post-read",
        async handler(context) {
          const result = await overflow(context);
          return result.kind === "return" || result.transform !== undefined
            ? result
            : scopes(result.context);
        },
      });
      api.describe({
        path: "ast:<path> — declaration outline.",
        views: "ast — scope boundaries.",
      });
    },
  } satisfies ReadPlugin;
  const editorPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "ast",
    setup(api) {
      api.addAnchorResolver({
        resolver: createAstScopeAnchorResolver(manager),
        kind: TEXT_POSITION_ANCHOR_KIND,
        type: "auxiliary",
      });
      api.addTextPresenter({ presenter });
    },
  } satisfies TextEditorPlugin;

  await Promise.all([
    connectReadPlugin(pi, readPlugin),
    connectDoctorPlugin(pi, astDoctorPlugin),
    connectTextEditorPlugin(pi, editorPlugin),
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "ast-search",
      setup(api): void {
        // Not registered with search: ast_search runs it through the shared execution core.
        resolveSearchApi({ api, resolver: createAstSearchResolver(api.registerSelection) });
      },
    }),
    registerAstSearchTool(pi, () => searchApi),
  ]);
}

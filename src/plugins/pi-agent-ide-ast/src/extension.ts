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
import { registerSelect } from "./tool-select.js";

const renderReadResult = createReadResultRenderer({ kind: "code-view", label: "AST" });

export default async function registerAst(pi: ExtensionAPI): Promise<void> {
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
          return result.kind === "return" ? result : scopes(result.context);
        },
      });
      api.describe({
        path: "ast:<path> — compact declaration outline for a code file.",
        views: "ast — scope boundaries alongside source text.",
      });
      await registerSelect(pi, api);
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
        api.addResolver({ resolver: createAstSearchResolver(api.registerSelection) });
        api.describe(
          "Search code structure with ast:<pattern>, using source-code syntax and placeholders such as $NAME for one node and $$$BODY for several nodes. path, include and exclude narrow the search. Use returned SEARCH# references to read, replace, copy, move or delete exact AST matches, including multiline nodes. A single :match reference becomes stale after its file changes; :all:match reruns the original structural query. Incomplete results do not provide all selections. Use the displayed capture NAME reference as a Search/Select/edit source. Single captures contain one node; multi captures retain provider nodes, including punctuation. Strict result scopes return only wholly contained matches. These edits do not update imports or references.",
        );
      },
    }),
  ]);
}

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

const renderReadResult = createReadResultRenderer({ kind: "code-view", label: "AST" });

export default async function registerAst(pi: ExtensionAPI): Promise<void> {
  const manager = new AstScopeManager();
  const presenter = createAstScopePresenter(manager);

  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "ast",
    setup(api) {
      api.addResolver({ resolver: createAstOutlineResolver(), renderResult: renderReadResult });
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
      api.describe(
        'ast:<path> — compact declaration outline. views: ["ast"] — scope boundaries alongside source text. Oversized code reads may return an outline with source line numbers; offset/limit read a smaller source range.',
      );
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
          "Search code structure with ast:<pattern>, using source-code syntax and placeholders such as $NAME for one node and $$$BODY for several nodes. path, include and exclude narrow the search. Use returned SEARCH# references to read, replace, copy, move or delete exact AST matches, including multiline nodes. A single :match reference becomes stale after its file changes; :all:match reruns the original structural query. Incomplete results do not provide all selections. Use captures in Apply to compute replacement text; these edits do not update imports or references.",
        );
      },
    }),
  ]);
}

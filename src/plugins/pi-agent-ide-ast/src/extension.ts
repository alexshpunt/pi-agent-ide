import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectDoctorPlugin } from "pi-agent-doctor/api/connect-plugin";
import { createSourceMappedTextReadHandler } from "pi-agent-ide/api/code-view";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-read/api/plugin-protocol";
import { registerOutlineTool, type OutlineRuntime } from "./tool-outline.ts";
import { connectSearchPlugin } from "pi-agent-search/api/connect-plugin";
import { SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-search/api/plugin-protocol";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_POSITION_ANCHOR_KIND,
  type TextEditorPlugin,
} from "pi-agent-text-editor/api/plugin-protocol";

import { probeLocalAstGrep } from "./ast-grep-binary.ts";
import { AstScopeManager } from "./ast/manager.ts";
import { astDoctorPlugin } from "./doctor-plugin.ts";
import { createAstOverflowHandler, reduceAstReadOutput } from "./overflow-handler.ts";
import { createAstScopePostReadHandler, createAstScopePresenter } from "./scope-handler.ts";
import { createAstScopeAnchorResolver } from "./scope-resolver.ts";
import { createAstSearchResolver } from "./search-resolver.ts";
import { registerAstSearchTool, type AstSearchRuntime } from "./tool-ast-search.ts";

export default async function registerAst(pi: ExtensionAPI): Promise<void> {
  let outlineRuntime: OutlineRuntime | undefined;
  registerOutlineTool(pi, () => outlineRuntime);
  let resolveSearchApi!: (value: AstSearchRuntime) => void;
  const searchApi = new Promise<AstSearchRuntime>((resolve) => (resolveSearchApi = resolve));
  const manager = new AstScopeManager();
  const presenter = createAstScopePresenter(manager);

  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "ast",
    async setup(api) {
      outlineRuntime = { api };
      api.addHandler({
        stage: "read",
        when: { resolvedBy: "outline", contentKind: "text" },
        handler: createSourceMappedTextReadHandler(),
      });
      // Scope context appends each scope's closing line, which may lie outside the range.
      api.addView({ view: "ast", presenter, showsLinesOutsideRange: true });
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
    },
  } satisfies TextEditorPlugin;

  // Agents must never see a tool that cannot run; `doctor` reports why ast-grep cannot start.
  const astGrep = await probeLocalAstGrep(process.cwd());
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
    ...(astGrep.ok ? [registerAstSearchTool(pi, () => searchApi)] : []),
  ]);
}

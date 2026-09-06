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
      api.addHandler({
        stage: "post-read",
        handler: createAstScopePostReadHandler(),
      });
      api.describe(
        "Provides compact structural outlines of source files through `ast:<path>` and the `ast` view.",
      );
      api.addPromptGuideline(
        "You can use read with `ast:<path>` for a compact structural overview of a source file, including its classes, functions, signatures, and other declarations.",
      );

      api.addPromptGuideline(
        'You can use read with `views: ["ast"]` to add scope boundaries alongside the file\'s source text.',
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
        api.addResolver({ resolver: createAstSearchResolver() });
        api.describe(
          "Use `ast:<pattern>` for structural code search through ast-grep. Optional path and glob fields limit the workspace scope.",
        );

        api.addPromptGuideline(
          "You can use search with `ast:<pattern>` for structural code search. You can limit it with `path`, `include`, and `exclude`.",
        );
      },
    }),
  ]);
}

import registerIdeCore from "#src/core/extension.js";
import registerDoctor from "#src/doctor/index.js";
import registerFilesystem from "#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.js";
import registerFilesystemImage from "#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-image/index.js";
import registerFilesystemPdf from "#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-pdf/index.js";
import registerFilesystemText from "#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.js";
import registerWeb from "#src/extensions/pi-agent-read/extensions/pi-agent-web/index.js";
import registerWebHtml from "#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-html/index.js";
import registerWebImage from "#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-image/index.js";
import registerWebPdf from "#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-pdf/index.js";
import registerWebText from "#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-text/index.js";
import registerReadCore from "#src/extensions/pi-agent-read/index.js";
import registerSearchCore from "#src/extensions/pi-agent-search/index.js";
import registerSemanticSearch from "#src/extensions/pi-agent-search/plugins/pi-agent-search-semantic/index.js";
import registerTextSearch from "#src/extensions/pi-agent-search/plugins/pi-agent-search-text/index.js";
import registerWebSearch from "#src/extensions/pi-agent-search/plugins/pi-agent-search-web/index.js";
import registerTextEditor from "#src/extensions/pi-agent-text-editor/index.js";
import registerConstantAnchors from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-constant/index.js";
import registerLineHashAnchors from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.js";
import registerArgumentOrder from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-argument-order/index.js";
import registerTextEditorRenderer from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/index.js";
import registerStaleAnchorGuard from "#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/index.js";
import registerAst from "#src/plugins/pi-agent-ide-ast/index.js";
import registerChanges from "#src/plugins/pi-agent-ide-changes/index.js";
import registerFormatter from "#src/plugins/pi-agent-ide-formatter/index.js";
import registerLanguages from "#src/plugins/pi-agent-ide-languages/index.js";
import registerLint from "#src/plugins/pi-agent-ide-lint/index.js";
import registerLsp from "#src/plugins/pi-agent-ide-lsp/index.js";

import type { BuiltinExtension } from "#src/composite/selection.js";

/**
Built-ins in their established registration order. IDs are stable configuration keys.
*/
export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
  builtin("ide.core", registerIdeCore),
  builtin("ide.doctor", registerDoctor),
  builtin("ide.languages", registerLanguages, ["ide.doctor"]),
  builtin("read.core", registerReadCore),
  builtin("read.filesystem", registerFilesystem, ["read.core", "editor.core"]),
  builtin("read.filesystem.image", registerFilesystemImage, ["read.filesystem"]),
  builtin("read.filesystem.pdf", registerFilesystemPdf, ["read.filesystem"]),
  builtin("read.filesystem.text", registerFilesystemText, ["read.filesystem"]),
  builtin("read.web", registerWeb, ["read.core"]),
  builtin("read.web.html", registerWebHtml, ["read.web"]),
  builtin("read.web.image", registerWebImage, ["read.web"]),
  builtin("read.web.pdf", registerWebPdf, ["read.web"]),
  builtin("read.web.text", registerWebText, ["read.web"]),
  builtin("search.core", registerSearchCore),
  builtin("search.text", registerTextSearch, ["search.core"]),
  builtin("search.semantic", registerSemanticSearch, ["search.core"]),
  builtin("search.web", registerWebSearch, ["search.core"]),
  builtin("editor.renderer", registerTextEditorRenderer, ["editor.core"]),
  builtin("editor.core", registerTextEditor),
  builtin("editor.anchor.constant", registerConstantAnchors, ["read.core", "editor.core"]),
  builtin("editor.anchor.line-hash", registerLineHashAnchors, ["read.core", "editor.core"]),
  builtin("editor.argument-order", registerArgumentOrder, ["editor.core"]),
  builtin("editor.stale-anchor", registerStaleAnchorGuard, ["editor.core"]),
  builtin("ide.ast", registerAst, ["ide.core", "read.core", "search.core", "editor.core"]),
  builtin("ide.formatter", registerFormatter, ["ide.core"]),
  builtin("ide.lint", registerLint, ["ide.core"]),
  builtin("ide.changes", registerChanges, ["ide.core", "read.core", "editor.core"]),
  builtin("ide.lsp", registerLsp, ["ide.core", "read.core", "search.core"]),
];

function builtin(
  id: string,
  register: BuiltinExtension["register"],
  dependencies: readonly string[] = [],
): BuiltinExtension {
  return { id, dependencies, register };
}

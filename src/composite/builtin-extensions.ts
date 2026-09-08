import type { BuiltinExtension } from "#src/composite/selection.js";

/**
 * Built-ins in their established registration order. Loading the catalog does not
 * import plugin code; only selected registrations load their modules.
 */
export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
  builtin("ide.core", () => import("#src/core/extension.js")),
  builtin("ide.tips", () => import("#src/tips/extension.js")),
  builtin("ide.doctor", () => import("#src/doctor/index.js")),
  builtin("ide.languages", () => import("#src/plugins/pi-agent-ide-languages/index.js"), [
    "ide.doctor",
  ]),
  builtin("read.core", () => import("#src/extensions/pi-agent-read/index.js")),
  builtin(
    "read.filesystem",
    () => import("#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.js"),
    ["read.core", "editor.core"],
  ),
  builtin(
    "read.filesystem.image",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-image/index.js"),
    ["read.filesystem"],
  ),
  builtin(
    "read.filesystem.pdf",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-pdf/index.js"),
    ["read.filesystem"],
  ),
  builtin(
    "read.filesystem.text",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.js"),
    ["read.filesystem"],
  ),
  builtin(
    "read.web",
    () => import("#src/extensions/pi-agent-read/extensions/pi-agent-web/index.js"),
    ["read.core"],
  ),
  builtin(
    "read.web.html",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-html/index.js"),
    ["read.web"],
  ),
  builtin(
    "read.web.image",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-image/index.js"),
    ["read.web"],
  ),
  builtin(
    "read.web.pdf",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-pdf/index.js"),
    ["read.web"],
  ),
  builtin(
    "read.web.text",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-text/index.js"),
    ["read.web"],
  ),
  builtin("search.core", () => import("#src/extensions/pi-agent-search/index.js")),
  builtin(
    "search.text",
    () => import("#src/extensions/pi-agent-search/plugins/pi-agent-search-text/index.js"),
    ["search.core"],
  ),
  builtin(
    "editor.renderer",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/index.js"),
    ["editor.core"],
  ),
  builtin("editor.core", () => import("#src/extensions/pi-agent-text-editor/index.js")),
  builtin(
    "editor.anchor.constant",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-constant/index.js"),
    ["read.core", "editor.core"],
  ),
  builtin(
    "editor.anchor.line-hash",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.js"),
    ["read.core", "editor.core"],
  ),
  builtin(
    "editor.anchor.exact",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-exact/index.js"),
    ["editor.core"],
  ),
  builtin(
    "editor.argument-order",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-argument-order/index.js"),
    ["editor.core"],
    false,
  ),
  builtin(
    "editor.overwrite",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-overwrite/index.js"),
    ["editor.core"],
    false,
  ),
  builtin(
    "editor.stale-anchor",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/index.js"),
    ["editor.core"],
  ),
  builtin("ide.ast", () => import("#src/plugins/pi-agent-ide-ast/index.js"), [
    "ide.core",
    "read.core",
    "search.core",
    "editor.core",
  ]),
  builtin("ide.formatter", () => import("#src/plugins/pi-agent-ide-formatter/index.js"), [
    "ide.core",
  ]),
  builtin("ide.lint", () => import("#src/plugins/pi-agent-ide-lint/index.js"), ["ide.core"]),
  builtin("ide.changes", () => import("#src/plugins/pi-agent-ide-changes/index.js"), [
    "ide.core",
    "read.core",
    "editor.core",
  ]),
  builtin("ide.lsp", () => import("#src/plugins/pi-agent-ide-lsp/index.js"), [
    "ide.core",
    "read.core",
    "search.core",
  ]),
  builtin("ide.diagnostics", () => import("#src/plugins/pi-agent-ide-diagnostics/index.js"), [
    "ide.core",
    "read.core",
  ]),
];

/** Defer module loading until the selected built-in is registered. */
function builtin(
  id: string,
  load: () => Promise<{ default: BuiltinExtension["register"] }>,
  dependencies: readonly string[] = [],
  defaultEnabled = true,
): BuiltinExtension {
  return {
    id,
    dependencies,
    async register(pi) {
      const extension = await load();
      await extension.default(pi);
    },
    ...(defaultEnabled ? {} : { defaultEnabled: false }),
  };
}

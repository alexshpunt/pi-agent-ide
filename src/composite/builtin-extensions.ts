import type { BuiltinExtension } from "#src/composite/selection.ts";
import { moduleLabels } from "./module-labels.ts";

/**
 * Built-ins in their established registration order. Loading the catalog does not
 * import plugin code; only selected registrations load their modules.
 */
export const BUILTIN_EXTENSIONS: readonly BuiltinExtension[] = [
  builtin("ide.core", () => import("#src/core/extension.ts")),
  builtin("ide.tips", () => import("#src/tips/extension.ts")),
  builtin("ide.doctor", () => import("#src/backend/doctor-registration.ts")),
  builtin("ide.languages", () => import("#src/plugins/pi-agent-ide-languages/index.ts"), [
    "ide.doctor",
  ]),
  builtin("read.core", () => import("#src/extensions/pi-agent-read/index.ts")),
  builtin(
    "ide.documentation",
    async () => {
      const { default: register } = await import("#src/documentation/extension.ts");
      return { default: (pi) => register(pi) };
    },
    ["read.core"],
  ),
  builtin(
    "read.filesystem",
    () => import("#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts"),
    ["read.core", "editor.core"],
  ),
  builtin("read.ssh", () => import("#src/backend/index.ts"), ["read.filesystem"]),
  builtin(
    "read.filesystem.jq",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-jq/index.ts"),
    ["read.filesystem", "ide.documentation", "ide.doctor"],
  ),
  builtin(
    "read.filesystem.image",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-image/index.ts"),
    ["read.filesystem"],
  ),
  builtin(
    "read.filesystem.pdf",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-pdf/index.ts"),
    ["read.filesystem"],
  ),
  builtin(
    "read.filesystem.text",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts"),
    ["read.filesystem"],
  ),
  builtin("read.web", () => import("#src/backend/web-registration.ts"), ["read.core"]),
  builtin(
    "read.web.html",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-html/index.ts"),
    ["read.web"],
  ),
  builtin(
    "read.web.image",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-image/index.ts"),
    ["read.web"],
  ),
  builtin(
    "read.web.pdf",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-pdf/index.ts"),
    ["read.web"],
  ),
  builtin(
    "read.web.text",
    () =>
      import("#src/extensions/pi-agent-read/extensions/pi-agent-web/plugins/pi-agent-web-text/index.ts"),
    ["read.web"],
  ),
  builtin("search.core", () => import("#src/extensions/pi-agent-search/index.ts")),
  builtin("search.semantic", () => import("#src/semantic/index.ts"), ["search.core"]),
  builtin(
    "search.text",
    () => import("#src/extensions/pi-agent-search/plugins/pi-agent-search-text/index.ts"),
    ["search.core"],
  ),
  builtin(
    "editor.renderer",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/index.ts"),
    ["editor.core"],
  ),
  builtin("editor.core", () => import("#src/extensions/pi-agent-text-editor/index.ts")),
  builtin(
    "editor.anchor.constant",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-constant/index.ts"),
    ["read.core", "editor.core"],
  ),
  builtin(
    "editor.anchor.line-hash",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-line-hash/index.ts"),
    ["read.core", "editor.core"],
  ),
  builtin(
    "editor.anchor.exact",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-exact/index.ts"),
    ["editor.core"],
  ),
  builtin(
    "editor.stale-anchor",
    () =>
      import("#src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-stale-anchor/index.ts"),
    ["editor.core"],
  ),
  builtin("ide.ast", () => import("#src/plugins/pi-agent-ide-ast/index.ts"), [
    "ide.core",
    "read.core",
    "search.core",
    "editor.core",
  ]),
  builtin("ide.formatter", () => import("#src/backend/formatter-registration.ts"), ["ide.core"]),
  builtin("ide.lint", () => import("#src/backend/lint-registration.ts"), ["ide.core"]),
  builtin("ide.changes", () => import("#src/backend/git-registration.ts"), [
    "ide.core",
    "read.core",
    "editor.core",
  ]),
  builtin("ide.lsp", () => import("#src/backend/lsp-registration.ts"), [
    "ide.core",
    "read.core",
    "search.core",
  ]),
  builtin("ide.processes", () => import("#src/plugins/pi-agent-ide-processes/index.ts")),
  builtin("ide.debugger", () => import("#src/backend/debugger-registration.ts"), [
    "ide.processes",
    "read.core",
    "editor.core",
  ]),
  builtin("ide.terminal", () => import("#src/plugins/pi-agent-ide-terminal/index.ts"), [
    "ide.processes",
    "read.core",
    "search.core",
    "editor.core",
    "editor.anchor.constant",
  ]),
  builtin("ide.diagnostics", () => import("#src/plugins/pi-agent-ide-diagnostics/index.ts"), [
    "ide.core",
    "read.core",
  ]),
];

/** Defer module loading until the selected built-in is registered. */
function builtin(
  id: keyof typeof moduleLabels,
  load: () => Promise<{ default: BuiltinExtension["register"] }>,
  dependencies: readonly string[] = [],
  defaultEnabled = true,
): BuiltinExtension {
  return {
    id,
    name: moduleLabels[id][0],
    description: moduleLabels[id][1],
    dependencies,
    async register(pi, context) {
      const extension = await load();
      await extension.default(pi, context);
    },
    ...(defaultEnabled ? {} : { defaultEnabled: false }),
  };
}

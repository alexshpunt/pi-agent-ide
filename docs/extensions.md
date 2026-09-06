# Writing extensions

Pi Agent IDE is designed to accept behavior from independent Pi extensions. You do not need to fork the umbrella package or add your extension to its built-in registry.

When its target core is enabled, an external extension can load before or after Pi Agent IDE. The connection helpers handle both orders through Pi's shared event bus.

## Choose a protocol

| You want to add                                          | Umbrella API                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A readable source or read presentation                   | `pi-agent-ide/api/read`, `pi-agent-ide/api/resource`                                                 |
| A search backend                                         | `pi-agent-ide/api/search`                                                                            |
| A writable source, anchor, mutation, guard, or renderer  | `pi-agent-ide/api/text-editor`, `pi-agent-ide/api/text`                                              |
| A formatter, compiler, or linter                         | `pi-agent-ide/api/connect-plugin`, `pi-agent-ide/api/toolchain`                                      |
| Doctor language knowledge, setup recipe, or health check | `pi-agent-ide/api/connect-doctor-plugin`, `pi-agent-ide/api/doctor`, `pi-agent-ide/api/tool-catalog` |
| Startup tip provider                                     | `pi-agent-ide/api/tips`                                                                              |

The internal packages are bundled into Pi Agent IDE and are not published separately. External extensions import their public contracts through the umbrella package.

A typical Pi package manifest starts like this:

```json
{
  "name": "my-pi-agent-ide-plugin",
  "type": "module",
  "keywords": ["pi-package"],
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "pi-agent-ide": "^0.1.0"
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

Use a `pi-agent-ide` range compatible with the release you target.

## Search plugin

A search plugin contributes one or more resolvers. A resolver returns `not-handled` when a query belongs to another backend.

```ts
import {
  connectSearchPlugin,
  SEARCH_API_VERSION,
  SEARCH_PROTOCOL,
  type SearchPlugin,
  type SearchResolver,
} from "pi-agent-ide/api/search";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const resolver: SearchResolver = {
  id: "tickets",

  async tryResolve(request) {
    if (!request.query.startsWith("ticket:")) {
      return { kind: "not-handled" };
    }

    const ticket = request.query.slice("ticket:".length).trim();
    return { kind: "resolved", payload: { ticket } };
  },

  format(payload) {
    const { ticket } = payload as { ticket: string };
    return {
      content: [{ type: "text", text: `Ticket ${ticket}` }],
      details: { ticket },
    };
  },
};

const plugin: SearchPlugin = {
  protocol: SEARCH_PROTOCOL,
  apiVersion: SEARCH_API_VERSION,
  id: "tickets",
  setup(api) {
    api.addResolver({ resolver });
    api.describe("Use `ticket:<id>` to find an issue tracker ticket.");
  },
};

export default function register(pi: ExtensionAPI): void | Promise<void> {
  return connectSearchPlugin(pi, plugin);
}
```

The search core validates the plugin and owns resolver ordering. Keep network clients and source-specific formatting inside your plugin.

## Read plugin

A read plugin usually contributes a `ResourceResolver`. The resolver recognizes a source and returns a Resource with explicit capabilities.

```ts
import {
  connectReadPlugin,
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
} from "pi-agent-ide/api/read";
import type { ResourceResolver } from "pi-agent-ide/api/resource";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const resolver: ResourceResolver = {
  id: "notes",

  async tryResolve(source) {
    if (!source.startsWith("note:")) {
      return { kind: "not-handled" };
    }

    const noteId = source.slice("note:".length);
    return {
      kind: "resolved",
      resource: {
        source,
        async read() {
          return [{ type: "text", text: `Note ${noteId}` }];
        },
      },
    };
  },
};

const plugin: ReadPlugin = {
  protocol: READ_PROTOCOL,
  apiVersion: READ_API_VERSION,
  id: "notes",
  setup(api) {
    api.addResolver({ resolver });
    api.describe("Reads `note:<id>` sources.");
  },
};

export default function register(pi: ExtensionAPI): void | Promise<void> {
  return connectReadPlugin(pi, plugin);
}
```

A read Resource does not become writable automatically. Register a matching resolver with the text-editor protocol only when writes are safe and well defined.

Read plugins can also add pipeline handlers, text presenters, and resolver-specific TUI renderers. See the [read plugin contract](https://github.com/alexshpunt/pi-agent-ide/blob/main/src/extensions/pi-agent-read/docs/plugins/plugin-protocol.md).

## Typed text targets

Use the public typed target contract when one opaque value should select ranges in one or more text Resources. Import it from the umbrella text API:

```ts
import type {
  TextSelectionRange,
  TextTarget,
  TextTargetResolutionAttempt,
  TextTargetResolver,
} from "pi-agent-ide/api/text";
```

A `TextTarget` contains a non-empty Resource `source` and optional half-open character `ranges`. Positions use one-based lines and zero-based columns. When `ranges` is omitted, read synthesizes a first-line chunk, while the editor treats the source as the target scope. Set `linewise: true` only when a range represents complete lines and mutation tools should preserve whole-line behavior at file edges.

The resolver owns its value syntax and returns `not-handled`, `resolved`, `rejected`, or `failed`. Consumers validate the result and must not parse strings such as `SEARCH#...` themselves.

A read plugin registers this contract with `api.addTargetResolver({ resolver })`. The read core returns one ordered line chunk per selected range, with `offset` and `limit` applied to each chunk before the aggregate output cap.

An editor anchor registration can expose the same resolver through its `resources` field. This lets a value in `path`, `target`, or an anchor field supply Resource sources and ranges before mutation. The editor resolves compatible explicit anchors in every selected Resource and unions the ranges. It rejects incompatible Resource sets, overlaps, stale selections, and malformed results before writing.

## Anchor plugin

Anchor resolvers recognize opaque values against the current text snapshot. This example adds a constant `middle` position.

```ts
import { TextAnchor, type TextAnchorResolver } from "pi-agent-ide/api/text";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  TEXT_POSITION_ANCHOR_KIND,
  type TextEditorPlugin,
} from "pi-agent-ide/api/text-editor";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

class MiddleAnchor extends TextAnchor {
  constructor(lineNumber: number) {
    super("middle", lineNumber);
  }
}

const resolver: TextAnchorResolver = {
  id: "middle",
  description: "`middle` selects the middle line.",

  async tryResolve(value, context) {
    if (value !== "middle") {
      return { kind: "not-handled" };
    }
    if (context.lines.length === 0) {
      return { kind: "failed", error: new Error("middle cannot resolve in an empty file") };
    }

    return {
      kind: "resolved",
      anchor: new MiddleAnchor(Math.ceil(context.lines.length / 2)),
    };
  },
};

const plugin: TextEditorPlugin = {
  protocol: TEXT_EDITOR_PROTOCOL,
  apiVersion: TEXT_EDITOR_API_VERSION,
  id: "middle-anchor",
  setup(api) {
    api.addAnchorResolver({
      resolver,
      kind: TEXT_POSITION_ANCHOR_KIND,
      type: "constant",
    });
  },
};

export default function register(pi: ExtensionAPI): void | Promise<void> {
  return connectTextEditorPlugin(pi, plugin);
}
```

Use `major` for the main per-line anchor format, `auxiliary` for additional displayed formats, and `constant` for symbolic positions that need no line marker. The core allows only one active major resolver.

More advanced anchors can return exact text selections, reject stale values with recovery context, or resolve one value to several Resource sources. See the [text-editor plugin contract](https://github.com/alexshpunt/pi-agent-ide/blob/main/src/extensions/pi-agent-text-editor/docs/plugins/plugin-protocol.md).

## IDE toolchain plugin

The IDE protocol accepts formatter, compiler, and linter implementations.

```ts
import { connectIdePlugin } from "pi-agent-ide/api/connect-plugin";
import { IDE_API_VERSION, IDE_PROTOCOL, type IdePlugin } from "pi-agent-ide/api/plugin-protocol";
import type { Formatter } from "pi-agent-ide/api/toolchain";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const formatter: Formatter = {
  kind: "formatter",
  name: "my-formatter",
  priority: 100,
  extensions: [".ts"],
  async detect() {
    return true;
  },
  async format() {
    return { ok: true, edits: 0 };
  },
};

const plugin: IdePlugin = {
  protocol: IDE_PROTOCOL,
  apiVersion: IDE_API_VERSION,
  id: "my-formatter",
  setup(api) {
    api.addTool(formatter);
  },
};

export default function register(pi: ExtensionAPI): void | Promise<void> {
  return connectIdePlugin(pi, plugin);
}
```

A real formatter runs inside the edit transaction and reports how many edits it applied. Only a compiler marked `syntaxOnly: true` may run before formatting. It must perform a fast parser check, not LSP or project/type analysis. Syntax errors skip formatting and keep the edit saved. A formatter can instead use its own parser to reject invalid text safely.

### Background diagnostics

IDE API version 3 separates diagnostic producers from file-writing tools. Register a read-only source with `api.addDiagnosticSource({ id, diagnose })`. `diagnose(filePath, context)` receives the workspace, final file `content`, an abort `signal`, and a revision-bound `publish(report)` callback for later updates. Return a report with `status`, `diagnostics`, and an optional failure `reason`. Coordinates are one-based.

- `ready` means the source checked this text.
- `unversioned` means the server omitted its document version, so freshness cannot be proved.
- `unavailable` means the source could not check this file. This is not a clean result.

Honor cancellation and never apply fixes from a diagnostic source. The core rejects results for superseded edits and ended sessions. Sources run in a bounded background queue after formatting. LSP push-only and pull-capable servers use the same diagnostic state as command linters. Empty updates clear earlier diagnostics.

`api.readDiagnostics(filePath, { cwd })` returns `{ filePath, content, results }`. It detects external text changes, reuses completed current checks, and waits at most five seconds for pending checks. Results still running have `status: "pending"`. Each background check has a thirty-second deadline; an individual provider may have a shorter timeout. Missing and failed sources remain explicit.

Changed per-file counts enter the next model request as a hidden custom context message. Updates are combined before delivery, contain no diagnostic details, and do not start an idle agent. This delivery is context-only, not a persistent session message. The `diagnostics:` protocol and `diagnostics` view expose details when the agent requests them. Neither replaces project builds or tests.

## Doctor plugin

A plugin should register only the knowledge and checks it owns. Use `connectDoctorPlugin` with a `DoctorPlugin` to add language definitions, setup recipes, or health checks. The doctor core accepts plugins in either load order and adds the owner ID to every report section and recipe.

Do not import another plugin's catalog or maintain a second central catalog. If your extension is disabled, its doctor contributions must disappear with it. Keep credentials out of findings and recipe data.

## Startup tip provider

Startup tips are optional and passive. A provider returns one tip for a session-start context, or `undefined` when it has nothing to show. Pi Agent IDE calls providers for the session-start lifecycle reason (`startup`, `reload`, `new`, `resume`, or `fork`) and appends at most one eligible tip to the TUI transcript when inspection finishes. Provider work does not block session readiness. Tips do not enter the model context or trigger an agent turn.

Shown tips are stored in the global Pi data directory at `pi-agent-ide/tips.json` (under `PI_CODING_AGENT_DIR`, or `~/.pi/agent` by default). The project path and provider ID are part of the stored identity, so each provider-owned tip is shown once per project. The claim is made atomically before rendering, which prevents concurrent Pi processes from displaying the same tip twice. If rendering fails, the claim is released so the tip can be retried. Unreadable or unwritable state is treated as empty and never blocks startup.

```ts
import { connectTipProvider, TIP_API_VERSION, TIP_PROTOCOL } from "pi-agent-ide/api/tips";

export default function register(pi: ExtensionAPI): void | Promise<void> {
  return connectTipProvider(pi, {
    protocol: TIP_PROTOCOL,
    apiVersion: TIP_API_VERSION,
    id: "my-tips",
    getTip: () => ({
      id: "my-tips-first-run",
      title: "Try the project check",
      body: "Run the project check before opening a pull request.",
    }),
  });
}
```

Providers should keep trigger decisions in `getTip`, avoid secrets in tip text, and never send the tip as an agent message.
Pass the supplied `context.signal` to cancellable work and stop when it is aborted. Pi Agent IDE cancels pending inspections when their session ends and ignores late results, including results from providers that do not honor cancellation.

## Install and test your extension

```bash
pi --no-extensions -e npm:pi-agent-ide -e ./index.ts
```

Install a package for normal use:

```bash
pi install npm:my-pi-agent-ide-plugin
```

Test protocol behavior in both load orders when ordering matters. For behavior that crosses Pi's loader, event bus, tools, sessions, filesystem, or terminal, use a real-Pi integration test rather than only calling `setup` in isolation.

The repository's external plugin integration fixture is a small working example:

- [`external-search-plugin.ts`](https://github.com/alexshpunt/pi-agent-ide/blob/main/tests/integration/composite/support/external-search-plugin.ts);
- [`unified-extension.integration.test.ts`](https://github.com/alexshpunt/pi-agent-ide/blob/main/tests/integration/composite/unified-extension.integration.test.ts).

## Keep boundaries clear

An extension should depend on the public protocol it implements, not on another extension's internal files. Prefer one narrow contribution over a plugin that reaches into several registries without a clear reason.

Do not add an external plugin ID to `disabled`. That setting in `extensions.json` controls only the built-ins shipped by Pi Agent IDE. Enable or disable your package through Pi's normal package and extension configuration.

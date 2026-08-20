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

A real formatter should run its normal formatter command and report how many edits it applied. Compilers and linters return structured diagnostics with one-based line and column positions.

## Doctor plugin

A plugin should register only the knowledge and checks it owns. Use `connectDoctorPlugin` with a `DoctorPlugin` to add language definitions, setup recipes, or health checks. The doctor core accepts plugins in either load order and adds the owner ID to every report section and recipe.

Do not import another plugin's catalog or maintain a second central catalog. If your extension is disabled, its doctor contributions must disappear with it. Keep credentials out of findings and recipe data.

## Install and test your extension

Try a local extension without installing it permanently:

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

Do not add an external plugin ID to `disabledExtensions`. That setting controls only the built-ins shipped by Pi Agent IDE. Enable or disable your package through Pi's normal package and extension configuration.

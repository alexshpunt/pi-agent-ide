# Writing extensions

Pi Agent IDE is designed to accept behavior from independent Pi extensions. You do not need to fork the umbrella package or add your extension to its built-in registry.

When its target core is enabled, an external extension using the connection helpers can load before or after Pi Agent IDE. The helpers handle both orders through Pi's shared event bus. Provider connectors that register local MCP aliases have a separate load-order requirement below.

## Provider connectors and local MCP aliases

The connection helpers support either load order. A provider connector that registers local MCP aliases for IDE tools is different: load Pi Agent IDE before that connector. Pi keeps the first extension's executable definition for each name. Loading the connector first can lose structured values returned to Codemode, even when the terminal panel looks correct.

Agent IDE recognizes an unnamespaced `mcp__*` tool as a local forwarding alias when its description and schema match exactly one visible IDE tool. Do not use that same metadata for a wrapper with different behavior: conflicting local extensions are the user's responsibility. Agent IDE does not keep a package allowlist and does not take over tools owned by a foreign MCP namespace.

For a matching alias, Agent IDE uses the native renderer and forwards execution to the original tool. Returned references, structured provider receipts and error outcomes keep their native contracts. A direct alias does not add a duplicate child panel.

Streaming edit guards preserve a connector's native provider registration, including OAuth and model discovery. When the guard is removed, it restores its transport hook without deleting that provider or replacing another extension's later transport.

A connector still owns authentication and model transport. Keeping Pi tools working does not add Claude Code's own tools or guarantee subscription billing. Test connectors one at a time; do not stack request patchers. See the [capability runner](https://github.com/alexshpunt/pi-agent-ide/blob/main/benchmarks/tool-capabilities/README.md) for isolated verification.

## Choose a protocol

| You want to add                                          | Umbrella API                                                                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| A readable source or read presentation                   | `pi-agent-ide/api/read`, `pi-agent-ide/api/resource`                                                 |
| A search backend                                         | `pi-agent-ide/api/search`                                                                            |
| A writable source, anchor, mutation, guard, or renderer  | `pi-agent-ide/api/text-editor`, `pi-agent-ide/api/text`                                              |
| A formatter, compiler, or linter                         | `pi-agent-ide/api/connect-plugin`, `pi-agent-ide/api/toolchain`                                      |
| Doctor language knowledge, setup recipe, or health check | `pi-agent-ide/api/connect-doctor-plugin`, `pi-agent-ide/api/doctor`, `pi-agent-ide/api/tool-catalog` |
| Boolean, choice or text settings in the shared menu      | `pi-agent-ide/api/settings`                                                                          |
| A user decision before a policy-gated operation          | `pi-agent-ide/api/approval`                                                                          |
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

## Settings

Use `registerAgentIdeSettings` from `pi-agent-ide/api/settings` once per extension runtime. The shared event bus accepts registration before or after Agent IDE loads. The settings appear in `/agent-ide-settings` and the live `docs:ide-settings` catalog.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentIdeSettings } from "pi-agent-ide/api/settings";

export default function register(pi: ExtensionAPI): void {
  registerAgentIdeSettings(pi, "my-extension", [
    {
      id: "my-extension-yolo",
      kind: "boolean",
      name: "YOLO: my extension",
      description: "Skip existing operation dialogs; technical guards still apply.",
      default: false,
    },
    {
      id: "my-extension.detail",
      kind: "choice",
      name: "Result detail",
      description: "Choose how much detail the extension displays.",
      group: "ui",
      default: "compact",
      values: [
        { value: "compact", label: "Compact" },
        { value: "full", label: "Full" },
      ],
    },
    {
      id: "my-extension.label",
      kind: "text",
      name: "Result label",
      description: "Set the label shown above extension results.",
      default: "",
      placeholder: "Optional label",
    },
  ]);
}
```

Each definition needs an ID, human name, description and default. `group: "ui"` places it in the UI tab; the default group is Behavior. Boolean settings accept optional On/Off labels; choice settings need unique values and labels and a default from that list. Text settings accept an optional placeholder. Prefix IDs with your extension's name: IDs are unique across all owners, including built-ins. Invalid metadata and duplicate registrations are errors, not replacements.

Boolean values use `flags`; choice and text values use `preferences`. All types support Project, Global and Default through the existing menu. Default removes only the selected scope's key. External registrations do not add Pi CLI flags. See [Configuration](configuration.md#agent-ide-settings) for storage paths and inheritance.

Read saved effective configuration through the host rather than duplicating storage policy:

```ts
import { readAgentIdeSetting } from "pi-agent-ide/api/settings";

const { value, overridden } = await readAgentIdeSetting(pi.events, "my-extension.detail", ctx.cwd);
```

`value` is a boolean or string. `overridden` means either scope saved an explicit value, including `false`; otherwise `value` is the registered default. The read does not include invocation-only CLI flags or claim live runtime state. A missing settings service, unknown ID or invalid saved configuration throws. Do not turn these errors into permission to mutate.

## Operation approval

Use `confirmOperation` from `pi-agent-ide/api/approval` when your extension's policy requires host permission. Pi Agent IDE owns the dialog, session grants and YOLO policy and serializes requests on the session's event bus. The standalone text editor installs the same dialog service.

```ts
import { confirmOperation } from "pi-agent-ide/api/approval";

const approved = await confirmOperation(pi.events, ctx, {
  owner: "my-extension",
  category: "remote-delete",
  yoloSetting: "my-extension-yolo",
  title: "Confirm remote deletion",
  message: `Delete: ${source}\nThis removes the selected remote object.`,
  signal,
});
if (!approved) return; // Do not dispatch the operation.
```

Call this inside a tool or lifecycle callback that supplies the actual context and abort signal. The context includes `cwd`, `hasUI`, `mode` and `ui.select`; pass its session manager to support remembered grants. Keep the exact target and action in the message. Use a stable extension `owner` and dialog `category`, not a target path or URL: **Allow for session** covers future requests with that pair, including different targets.

The dialog offers **Deny**, **Allow once** and, when session storage is available, **Allow for session**. Session grants are non-context entries on the current branch. They survive runtime reload and saved-session reopening, but do not transfer to a new independent session or a branch without that entry. Persistent YOLO is separate: `yoloSetting` is optional, names a registered boolean, and opts into the host's common/provider policy. Without it, persistent YOLO does not bypass this request. Do not implement that policy again in your extension. See [Operation confirmations and YOLO](configuration.md#operation-confirmations-and-yolo) for precedence and user settings.

Your extension still owns risk classification, authorization, technical guards and any one-operation permit. A positive answer authorizes the current request; it is not proof that the operation completed. Revalidate and consume the target-specific permit before dispatch even when YOLO or a session grant supplied permission.

The service marks Herdr as waiting only while a terminal dialog is open and clears that state when it closes. RPC dialogs do not claim terminal waiting. Refusal, dismissal, cancellation, dialog/policy failure and missing approval service return `false`. Without UI, only a matching session grant or configured YOLO can grant permission. Session shutdown cancels active and queued requests. Pass the operation's actual abort signal; a `tool_call` hook receives the turn signal, not a nested `executeTool` child's signal.

Do not emit Herdr waiting events or implement another approval popup in your provider. Only call this API for operations that already require permission; it does not add gates to auto-allowed calls.

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

A formatter result can set `formatter` to the actual executable name. Built-in command formatters do this so diff statuses and agent results name the command, not the wrapper extension. Omit it for a formatter implemented by the named plugin itself. Set it to `null` when no formatter was selected; the edit then has no formatting-success status.

### Background diagnostics

IDE API version 3 separates diagnostic producers from file-writing tools. Register a read-only source with `api.addDiagnosticSource({ id, diagnose })`. `diagnose(filePath, context)` receives the workspace, final file `content`, an abort `signal`, and a revision-bound `publish(report)` callback for later updates. Return a report with `status`, `diagnostics`, and an optional failure `reason`. Set `source` to the actual reporting tool name when the registered producer delegates to a command. The core keeps the registered ID for updates, but uses the report's name in reads, model notifications, and chat summaries. Coordinates are one-based.

- `ready` means the source checked this text.
- `unversioned` means the server omitted its document version, so freshness cannot be proved.
- `unavailable` means the source could not check this file. This is not a clean result.

Honor cancellation and never apply fixes from a diagnostic source. The core rejects results for superseded edits and ended sessions. Sources run in a bounded background queue after formatting. LSP push-only and pull-capable servers use the same diagnostic state as command linters. Empty updates clear earlier diagnostics.

`api.readDiagnostics(filePath, { cwd })` returns `{ filePath, content, results }`. It detects external text changes, reuses completed current checks, and waits at most five seconds for pending checks. Results still running have `status: "pending"`. Each background check has a thirty-second deadline; an individual provider may have a shorter timeout. Missing and failed sources remain explicit.

Changed per-file counts from nonempty reports immediately send a hidden custom session message and appear in a separate chat summary. Pending, unavailable, and empty sources are excluded from both. Empty updates still clear cached findings without sending a notification, and a later recurrence can notify again. Delivery is serialized and duplicate reports stay silent. Messages contain counts rather than diagnostic details. They start a turn when the agent is idle and use Pi's steering queue during an active run. Session shutdown cancels pending checks and delivery. The `diagnostics:` protocol and `diagnostics` view expose details when the agent requests them. Neither replaces project builds or tests.

## Doctor plugin

A plugin should register only the knowledge and checks it owns. Use `connectDoctorPlugin` with a `DoctorPlugin` to add language definitions, setup recipes, or health checks. The doctor core accepts plugins in either load order and adds the owner ID to every report section and recipe.

Do not import another plugin's catalog or maintain a second central catalog. If your extension is disabled, its doctor contributions must disappear with it. Keep credentials out of findings and recipe data.

## Startup tip provider

Startup tips are optional and passive. A provider returns one tip for a session-start context, or `undefined` when it has nothing to show. Pi Agent IDE calls providers for the session-start lifecycle reason (`startup`, `reload`, `new`, `resume`, or `fork`) and appends at most one eligible tip to the TUI transcript when inspection finishes. Provider work does not block session readiness. Tips do not enter the model context or trigger an agent turn.

Shown tips are stored in the global Pi data directory at `pi-agent-ide/tips.json` (under `PI_CODING_AGENT_DIR`, or `~/.pi/agent` by default). Tips default to `scope: "project"` and are shown once per project. Use `scope: "global"` for a tip shown once across the installation. Both scopes keep the provider ID and tip ID in their identity. Keep a stable tip ID across package updates; change it only when a materially revised hint should be shown again. The claim is made atomically before rendering, which prevents concurrent Pi processes from displaying the same tip twice. If rendering fails, the claim is released so the tip can be retried. Unreadable or unwritable state is treated as empty and never blocks startup.

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

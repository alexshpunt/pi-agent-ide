# Read plugin protocol

## Purpose

This protocol connects independently loaded read plugins to one `pi-agent-read` core instance.

A plugin may register ResourceResolvers, resolver-owned TUI result renderers, pipeline handlers, and one static or lazy prompt description. `pi.events` carries registration and readiness messages only.

## Public surface

The protocol is exported from `pi-agent-read/api/plugin-protocol`:

```ts
const READ_PROTOCOL = "pi-agent-read";
const READ_API_VERSION = 6;
const READ_PLUGIN_REGISTER_EVENT = "pi-agent-read/plugin/register";
const READ_CORE_READY_EVENT = "pi-agent-read/core/ready";

interface ReadPlugin {
  readonly protocol: typeof READ_PROTOCOL;
  readonly apiVersion: typeof READ_API_VERSION;
  readonly id: string;
  setup(api: ReadPluginApi): void | Promise<void>;
}

type PromptDescriptionSource = string | (() => string | undefined);
type ReadResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
type ReadPluginApi = ReadToolPluginApi;

interface ReadToolPluginApi {
  read(request: ReadRequest, context: ResourceResolverContext): Promise<ReadToolResult>;
  addResolver(registration: ResourceResolverRegistration): void;
  addHandler(registration: ReadHandlerRegistration): void;
  addTextPresenter(registration: TextPresenterRegistration): void;
  describe(description: PromptDescriptionSource): void;
}

interface ResourceResolverRegistration {
  readonly resolver: ResourceResolver;
  readonly priority?: number;
  readonly renderResult?: ReadResultRenderer;
  readonly preserveTruncatedOutput?: boolean;
}
```

`ResourceResolver` comes from `pi-agent-resource`. Priority is read-registry metadata: lower values run first and the default is `0`.

`renderResult` is optional display behavior for results owned by that resolver. It does not change agent content. Core stores the selected resolver ID in `ReadResultDetails.resolvedBy`, then uses that ID to select the renderer when Pi draws a new or restored tool result. If the renderer is unavailable, core uses its source-neutral fallback.

`preserveTruncatedOutput` opts a resolver into temporary snapshots. When its final text is automatically truncated, core saves the complete final text and returns a `temp:<id>` source. The default is `false`.

`pi-agent-read/api/rendering` exports `createReadResultRenderer()` for the standard source, Markdown, and code-view panels. A source plugin may use that factory or provide its own Pi tool-result renderer.

Read has one tool, so the plugin API is flat. The protocol exports no tool ID value.

`api.read()` runs the same live pipeline as the registered `read` tool. It uses the current resolvers, handlers, and text presenters, so another extension can request agent-ready read output without copying read behavior or invoking a Pi tool.

The connection helper is exported from `pi-agent-read/api/connect-plugin`:

```ts
await connectReadPlugin(pi, plugin);
```

Importing either API module has no registration side effects.

## Registration boundary

Each core instance owns its accepted plugin IDs, pending setup promises, resolver registrations, handler registrations, description sources, and stable order.

Core validates:

- the exact protocol and API version;
- a non-empty plugin ID;
- each ResourceResolver with `isResourceResolver`;
- registry-local resolver ID uniqueness;
- read-specific priority, optional renderer, and handler registration fields;
- one valid prompt description source per plugin.

`any` is reserved as a read-handler selector and is rejected as a resolver ID by this registry.

The same plugin object may be delivered more than once by the readiness handshake. Core returns the same registration promise without duplicating contributions. A different object with the same active plugin ID is rejected.

## Setup transaction

Core invokes and awaits `plugin.setup(api)`. Contributions made during setup are collected in one draft and committed only after setup succeeds and the complete draft validates.

If setup fails:

- none of the draft contributions are installed;
- the retained API is closed;
- the plugin ID may be registered again.

After a successful commit, the retained API remains live and validates later contributions before installing them.

## Readiness handshake

Both extension load orders are supported.

### Core first

1. Core subscribes to `pi-agent-read/plugin/register`.
2. Core emits `pi-agent-read/core/ready`.
3. The plugin sends its registration request.
4. Core acknowledges it with the registration promise.
5. Pi awaits plugin setup.

### Plugin first

1. The plugin subscribes to `pi-agent-read/core/ready`.
2. Its eager request has no listener, so the extension returns.
3. Core loads and emits readiness.
4. The plugin sends the same stable object again.
5. Core acknowledges and awaits setup.

The request uses `accept(registrationPromise)` because Pi's event bus is not an asynchronous request-response API.

Core and plugin readiness subscriptions are owned by the Pi extension instance that created them. Both sides unsubscribe on `session_shutdown`, including a plugin that is still waiting for a core. Reload and session replacement therefore register only the new core and plugin objects on Pi's shared event bus.

## Execution

After registration, the event bus is not used for reads.

For one tool invocation, core creates one `ReadPipelineContext` and passes that same object through every stage:

```text
pre-read
    -> ResourceResolver selection
        -> Resource.read
            -> read handlers
                -> text presenters in parallel
                    -> result projection
                        -> post-read
```

The context contains the original request and resolver context. After resolution it also contains the full `ReadState`; after projection it contains the current `ReadToolResult`. Handlers return a new context when they change either value. This keeps the source snapshot and final result correlated without global plugin state.

Pipeline handlers remain sequential because later handlers receive the context returned by earlier handlers. Text presenters are independent: core starts them concurrently against one canonical text snapshot, then merges presentation contributions in priority and registration order. A text presenter must not change canonical text or line identity.

The exact resolver, validation, capability, pipeline, and failure behavior is defined in [`tool-read.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-read/docs/tools/tool-read.md).

## Prompt contributions

`api.describe()` contributes one static string or lazy renderer for the read capability. Core evaluates lazy renderers only while `read` is active. `undefined` omits one plugin from that snapshot. Rendering is defined in [`prompt-contributions.md`](/agent/src/extensions/pi-agent-ide/extensions/pi-agent-read/docs/plugins/prompt-contributions.md).

## Testing contract

Integration tests load real core and plugin entrypoints in both load orders. Core tests verify resolver registration, renderer routing through saved resolver IDs, lazy descriptions, and runtime Resource boundaries directly.

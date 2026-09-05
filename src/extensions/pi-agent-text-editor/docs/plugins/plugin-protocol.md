# Text editor plugin protocol

## Purpose

The protocol lets independent extensions contribute editable Resource resolvers, text anchor and typed target resolvers, prompt descriptions, and tool pipeline handlers.

```ts
const TEXT_EDITOR_PROTOCOL = "pi-agent-text-editor";
const TEXT_EDITOR_API_VERSION = 17;

interface TextEditorPluginApi {
  addResolver(registration: ResourceResolverRegistration): void;
  inspectTextAnchors(request: TextAnchorInspectionRequest): Promise<TextAnchorInspectionOutcome>;
  addAnchorResolver(registration: TextAnchorResolverRegistration): void;
  recoveryConfig(section: string): TextEditorRecoveryConfigSection;
  addTextPresenter(registration: TextPresenterRegistration): void;
  addMutationTool(registration: TextMutationToolRegistration): void;
  addMutationGuard(registration: TextMutationGuardRegistration): void;
  onMutationTool(listener: TextMutationToolListener): () => void;
  onDidEdit(listener: TextEditCompletionListener): () => void;
  addToolRenderer(registration: TextEditorToolRendererRegistration): void;
  previewMutation(request: TextMutationPreviewRequest): Promise<TextMutationPreviewOutcome>;
  describe(description: PromptDescriptionSource): void;
  tool(tool: TextEditorToolId): TextEditorToolPluginApi;
}

interface TextEditorRecoveryConfigSection {
  readonly contextLines: number;
  readonly timeoutMs: number;
  readonly settings: unknown;
}
```

Plugins connect with `connectTextEditorPlugin(pi, plugin)`. Core-first and plugin-first load orders are supported. Setup contributions commit atomically after asynchronous setup succeeds.

## Mutation tools

`api.addMutationTool()` registers a complete text mutation. One registration contains the tool schema, source fields, anchor fields, and mutation operation. Core validates the full registration before it exposes the agent tool. Built-in and plugin-owned mutations use this same path.

Each anchor descriptor names its argument field, its Resource source field, and the dynamic anchor kinds it accepts. A mutation resolves an anchor by that field name. Core reads the value and Resource from the descriptor and sends the opaque value to the anchor registry. Equal strings in different fields never merge their Resource or kind constraints.

A mutation receives the representative primary document through `sourceDocument`. It can use `sourceFor(field)` and `documentFor(source)` for every declared or expanded Resource, and `resolveAnchors(field)` for the per-Resource anchor set. `targetDocument(field)` and `resolveAnchor(field)` remain the one-Resource forms. The mutation returns generic ranges and inserted text instead of final file content.

A mutation may read and change more than one Resource. Core expands global anchor Resources, reads every required Resource before mutation, calculates every final document, runs mutation guards, then writes changed Resources in stable order. Direct and batched calls use the same change contract; pathless global anchors use the direct path.

For built-in span mutations, a plain source path only scopes anchor resolution. It never selects the full document by itself. A typed source path can supply the selection ranges, so `replace`, `delete`, and `insert` may omit their source anchor. `copy` and `move` may omit their source start only when the typed path yields one usable span in one Resource.

Supplying both start and end fields creates one natural span from the left edge of the start selection through the right edge of the end selection. Both endpoints must resolve to one Resource and one usable range. Without an end field, supported selection operations may apply independently to several ranges and Resources.

A mutation may return `afterWrite` when it must update related state only after all Resource writes, post-edit handlers, and final rereads succeed. Direct and batched calls await it before reporting success. If it fails, the tool reports `POST_WRITE_FAILED` with an applied effect because the Resource writes have already completed. Mutation previews do not run it.

The TypeBox property order is the accepted argument order. Primary source metadata controls sibling path inheritance and batch discovery. `api.onMutationTool()` receives every existing registration immediately and then receives later registrations, so extension load order does not change protection.

A mutation registration may set `intent` to `restore`; otherwise it is an ordinary `edit`. A batch is `edit` or `restore` when all calls have that intent, and `mixed` when both appear. Guards and completion listeners receive the invocation intent without depending on a tool name.

## Edit completions

`api.onDidEdit()` observes a changed Resource after its write, post-edit handlers, and final reread have finished. One completion contains the requested source, resolved Resource source, resolver ID, cwd, prior existence, raw before and final after documents, and invocation intent.

A direct mutation produces one completion per changed file. A successful coalesced batch also produces one completion per changed file, with the state before and after the complete batch. A write-phase failure produces no completions, including when rollback is incomplete. Presenters run after notification and do not alter the raw final document seen by listeners.

The editor does not retain completions or provide history. Listener failures do not turn a successful write into a failed tool result.

## Tool renderers

`api.addToolRenderer()` contributes `renderCall`, `renderResult`, and optionally `renderShell` for one text mutation tool. Renderers must be registered before that mutation tool is exposed to Pi. Missing renderer slots are omitted from the Pi tool definition, so Pi uses its built-in rendering for them. Normal registrations replace only the slots they provide. A registration with `fallback: true` fills only slots that do not already have a renderer, regardless of extension load order.

The bundled mutation renderer observes every mutation registration and contributes the standard diff as a fallback. It reads source and anchor field names from the mutation metadata, so external tools get the same diff without importing the renderer or being named inside it.

`api.previewMutation()` reads the declared Resources, resolves anchors through the active anchor registry, and applies the registered mutation in memory. It returns the original text, resulting text, changed ranges, and Resource navigation link without running guards, post-edit handlers, presenters, or Resource writes. Renderers can retain their component between call and result renders, keep the last completed preview visible while a newer preview runs, and discard an older result when newer arguments arrive.

## Mutation guards

`api.addMutationGuard()` registers a source-neutral check over a prepared mutation plan. Plans contain resolved Resource identities, original and final documents, existence state, and changes reported by the local engine. Guards do not inspect tool names or parse anchors.

Core snapshots committed guards once per invocation and runs them after all anchors resolve but before persistence. A rejection is an expected not-applied result. A thrown guard is reported as `PLUGIN_FAILED`.

All Resource resolution, reads, target and anchor checks, change application, and guards finish before the first write. Those failures have no applied effect. If a later Resource write fails, core attempts to restore the failed Resource and every Resource already written, and reports any rollback failures.

`copy` and `move` always need a destination selection. `target` supplies its Resource scope and defaults to the source scope; it does not select a position by itself. `targetStart`, or a typed `target` with an implicit range, supplies the destination selection. Without `targetEnd`, the tools insert after its natural end. With `targetEnd`, they replace the inclusive natural destination span. The old destination `anchor` field does not exist.

## Resource resolvers

Resource resolver contracts come from [`pi-agent-resource`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-resource/docs/resolver.md). The editor owns registry priority, stable order, duplicate ID checks, and terminal failure mapping.

The editor Resource registry is independent from the read Resource registry.

## Anchor resolvers

Anchor resolver contracts come from [`pi-agent-text`](/agent/src/extensions/pi-agent-ide/packages/pi-agent-text/north-star.md).

```ts
type TextAnchorType = "major" | "auxiliary" | "constant";

interface TextAnchorResolverRegistration {
  readonly resolver: TextAnchorResolver;
  readonly resources?: TextAnchorResourceResolver;
  readonly kind: string;
  readonly type: TextAnchorType;
  readonly priority?: number;
}
```

`kind` is an open, namespaced string that states which mutation fields may use the resolver. The editor exports `pi-agent-text-editor/position` for line selectors and `pi-agent-text-editor/search` for exact search selections.

`resources` is optional. It is the public `TextTargetResolver` contract from `pi-agent-text`. It recognizes the same opaque value before any Resource is read and may return ordered Resource sources with half-open character ranges. `not-handled` leaves normal source resolution unchanged; rejection, failure, or malformed output stops the mutation before writes. The editor validates and uses this typed result. It does not parse the resolver's string format.

The same typed value may appear in an anchor field or in a mutation source field such as `path` or `target`. A source-field result supplies implicit ranges for that field's anchor. When a compatible explicit anchor is also present, the editor resolves it against every selected Resource and unions its natural range with the implicit ranges. Resource-set mismatches, incompatible selection shapes, ambiguous ranges, and overlaps are rejected before persistence.

`api.addAnchorResolver()` registers one resolver with presentation metadata:

- `major` is the main systematically displayed line anchor; at most one may be active;
- `auxiliary` is an additional format shown where relevant;
- `constant` is a symbolic line selector that needs no per-line display.

Presentation type does not change compatibility or ordering. Priority defaults to `0`; lower values run first, followed by stable registration order. Resolver IDs are unique across the editor registry.

The resolver owns format recognition, freshness checks, and recovery data. It returns `not-handled`, `resolved`, `rejected`, or `failed`. A rejected result contains a reason and may include a Resource range that the read pipeline can render for recovery.

A resolver may return `TextSelectionAnchor` when the editor operation needs exact text instead of whole lines. It carries ordered, non-overlapping ranges for one Resource. Core rejects ranges whose source, lines, or columns do not match the current snapshot.

`api.inspectTextAnchors()` resolves and reads the current Resource, then sends each anchor through the same registry path used by direct edits, batches, and recovery. It resolves each value independently. The registry does not define relationships between multiple anchors; the mutation that owns the fields validates any relationship it needs.

For each value:

- `not-handled` continues;
- `resolved` returns a base line or a validated editor selection and stops;
- `rejected` stops with the resolver's reason and recovery data;
- `failed`, throw, reject, malformed output, and an out-of-range position stop with failure.

## Prompt contributions

When an editor tool is active, core may render:

- `# Writable Resources` from provider descriptions;
- `# Text Editor Tools Extensions` from tool descriptions;
- `# Available Text Anchors` from resolver descriptions.

Anchor descriptions are grouped as Major, Auxiliary, and Constant. Each resolver owns its complete prose, examples, and restrictions. Lazy descriptions are evaluated for each prompt snapshot and may return `undefined`.

No anchor section is rendered when no active resolver supplies a description or no editor tool is active.

## Setup validation

Core validates protocol version, plugin ID, resolver shapes, priorities, duplicate IDs, the single-major rule, handler registrations, and description multiplicity, and mutation metadata before committing the setup draft. A failed setup installs nothing.

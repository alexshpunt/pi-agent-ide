import { requiredValue } from "pi-agent-invariant";
import {
  connectResultTargets,
  normalizeStructuredArguments,
  ResourceError,
} from "pi-agent-resource";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import { getLastResolvedResource } from "pi-agent-text-editor/api/last-resolved-resource";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
  type TextEditorPlugin,
  type TextEditorPluginApi,
} from "pi-agent-text-editor/api/plugin-protocol";
import {
  formatStaleAnchorMessage,
  type StaleAnchorMessageDetails,
} from "pi-agent-text-editor/api/stale-anchor-message";
import {
  type InterceptorContext,
  type InterceptResult,
  registerToolCallInterceptor,
  type ToolCallInterceptorHandler,
} from "pi-agent-text-editor/api/tool-call-interceptor";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextAnchorInspectionOutcome } from "pi-agent-text-editor/api/anchor-inspection";
import {
  isMutationAnchorValue,
  type TextMutationToolRegistration,
} from "pi-agent-text-editor/api/mutation-tool";

import { editingSelectorPairs } from "pi-agent-text-editor/api/text-selector-fields";

const CACHE_KEY_PART_SEPARATOR = "\u{0}";
const CACHE_KEY_LIST_SEPARATOR = "\u{1}";

export default async function registerTextEditorStaleAnchor(pi: ExtensionAPI): Promise<void> {
  const editorPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "text-editor-stale-anchor",
    setup(api) {
      const dynamic = createHandler(pi, api);
      registerToolCallInterceptor(pi, dynamic.handler);
      api.onMutationTool(dynamic.add);
    },
  } satisfies TextEditorPlugin;

  await connectTextEditorPlugin(pi, editorPlugin);
}

function createHandler(
  pi: ExtensionAPI,
  api: TextEditorPluginApi,
): {
  readonly handler: ToolCallInterceptorHandler;
  readonly add: (registration: TextMutationToolRegistration) => void;
} {
  const resultTargets = connectResultTargets(pi);
  const schemas = new Map<string, TextMutationToolRegistration>();
  const toolNames: string[] = [];
  const knownPaths = new Map<number, string>();
  const checks = new Map<number, Map<string, TextAnchorInspectionOutcome>>();
  const blocks = new Map<number, Map<string, InterceptResult>>();

  const handler: ToolCallInterceptorHandler = {
    name: "text-editor-stale-anchor-inspection",
    blockExecution: true,
    toolNames,
    async intercept(context) {
      const schema = schemas.get(context.toolCall.name);

      if (schema === undefined) {
        return;
      }

      // Inspection may use a selection's owning resource, but must never replace the caller's
      // selection with that whole resource in the arguments that eventually authorize the edit.
      const arguments_ = {
        ...normalizeStructuredArguments(context.partialArgs ?? context.args, schema.parameters, {
          cwd: context.cwd,
          sourceFields: [
            schema.source.field,
            ...(schema.source.targets ?? []).map((target) => target.field),
          ],
          resolveSource: (value) => resultTargets.source(value, context.cwd, true),
        }),
      };
      try {
        for (const field of [
          schema.source.field,
          ...(schema.source.targets ?? []).map((target) => target.field),
        ]) {
          const original = arguments_[field];
          if (original === undefined) continue;
          const source = resultTargets.source(original, context.cwd);
          if (typeof source === "string" && !source.startsWith("RESULT#")) {
            // Unregistered Search selectors still belong to their own resolver.
            if (source.startsWith("SEARCH#")) return;
            arguments_[field] = source;
            continue;
          }
          const selected = resultTargets.resolve(source, context.cwd, {
            forScope: true,
            allowAdjusted: true,
          });
          if (!selected.complete || selected.targets.length !== 1) return;
          arguments_[field] = selected.targets[0]?.source;
        }
      } catch (error) {
        if (error instanceof ResourceError && error.code === "NO_EDITABLE_TEXT")
          return makeResolverBlockResult(
            context.toolCall.name,
            schema.source.field,
            error.source,
            error.code,
          );
        // Unsupported values, expired IDs and selections without a unique owning source are
        // refused by the result-input pipeline, not by filename anchor inspection.
        return;
      }
      const source = resolveSource(
        arguments_,
        context,
        knownPaths,
        schema.source.field,
        schema.source.inherited ? getLastResolvedResource(pi)?.source : undefined,
      );

      if (source === undefined) {
        return;
      }

      let pairs: ReturnType<typeof editingSelectorPairs>;
      try {
        pairs = editingSelectorPairs(schema.name, arguments_);
      } catch {
        // Wait for valid boundaries; execution reports invalid combinations.
        return;
      }
      if (schema.pair !== undefined)
        pairs.push({ sourceField: schema.source.field, fields: schema.pair });
      const paired = new Set<string>();
      for (const { sourceField, fields } of pairs) {
        const candidateSource = arguments_[sourceField];
        const pairBlock = await inspectAnchorPair(
          api,
          context,
          schema,
          arguments_,
          typeof candidateSource === "string" ? candidateSource : source,
          fields,
          checks,
          blocks,
        );
        if (pairBlock !== undefined) return pairBlock;
        if (fields.every((field) => typeof arguments_[field] === "string"))
          for (const field of fields) paired.add(field);
      }

      for (const descriptor of schema.anchors ?? []) {
        if (paired.has(descriptor.field)) {
          continue;
        }

        const anchor = arguments_[descriptor.field];

        if (!isMutationAnchorValue(descriptor, anchor)) {
          continue;
        }

        const candidateSource = arguments_[descriptor.sourceField];
        const anchorSource = typeof candidateSource === "string" ? candidateSource : source;
        const block = await inspectAnchors(
          api,
          context,
          [descriptor.field],
          anchorSource,
          [anchor],
          [descriptor.kinds],
          checks,
          blocks,
        );

        if (block !== undefined) {
          return block;
        }
      }

      return;
    },
    onContentEnd(contentIndex) {
      checks.delete(contentIndex);
      blocks.delete(contentIndex);
    },
    onAbort(contentIndex) {
      checks.delete(contentIndex);
      blocks.delete(contentIndex);
      knownPaths.delete(contentIndex);
    },
    onAgentEnd() {
      checks.clear();
      blocks.clear();
      knownPaths.clear();
    },
  };

  return {
    handler,
    add(registration): void {
      if (!((registration.anchors?.length ?? 0) > 0)) {
        return;
      }

      schemas.set(registration.name, registration);
      toolNames.push(registration.name);
      registerToolCallInterceptor(pi, handler);
    },
  };
}

function resolveSource(
  arguments_: Record<string, unknown>,
  context: InterceptorContext,
  knownPaths: Map<number, string>,
  sourceField: string,
  lastResolvedSource: string | undefined,
): string | undefined {
  const explicit = arguments_[sourceField];

  if (typeof explicit === "string") {
    if (context.contentIndex !== undefined) {
      knownPaths.set(context.contentIndex, explicit);
    }

    return explicit;
  }

  if (context.contentIndex !== undefined) {
    for (let index = context.contentIndex - 1; index >= 0; index -= 1) {
      const inherited = knownPaths.get(index);

      if (inherited !== undefined) {
        arguments_[sourceField] = inherited;
        return inherited;
      }
    }
  }

  if (lastResolvedSource !== undefined) {
    arguments_[sourceField] = lastResolvedSource;
  }

  return lastResolvedSource;
}

async function inspectAnchorPair(
  api: TextEditorPluginApi,
  context: InterceptorContext,
  schema: TextMutationToolRegistration,
  arguments_: Record<string, unknown>,
  source: string,
  [startField, endField]: readonly [string, string],
  checks: Map<number, Map<string, TextAnchorInspectionOutcome>>,
  blocks: Map<number, Map<string, InterceptResult>>,
): Promise<InterceptResult | undefined> {
  const start = arguments_[startField];
  const end = arguments_[endField];

  if (typeof start !== "string" || typeof end !== "string") {
    return undefined;
  }

  const startDescriptor = schema.anchors?.find(({ field }) => field === startField);
  const endDescriptor = schema.anchors?.find(({ field }) => field === endField);

  if (startDescriptor === undefined || endDescriptor === undefined) {
    return undefined;
  }

  if (
    !isMutationAnchorValue(startDescriptor, start) ||
    !isMutationAnchorValue(endDescriptor, end)
  ) {
    return undefined;
  }

  return inspectAnchors(
    api,
    context,
    [startField, endField],
    source,
    [start, end],
    [startDescriptor.kinds, endDescriptor.kinds],
    checks,
    blocks,
  );
}

async function inspectAnchors(
  api: TextEditorPluginApi,
  context: InterceptorContext,
  fields: readonly [string] | readonly [string, string],
  source: string,
  anchors: readonly [string] | readonly [string, string],
  kinds: readonly [readonly string[]] | readonly [readonly string[], readonly string[]],
  checks: Map<number, Map<string, TextAnchorInspectionOutcome>>,
  blocks: Map<number, Map<string, InterceptResult>>,
): Promise<InterceptResult | undefined> {
  const contentIndex = context.contentIndex ?? -1;
  const key = `${source}${CACHE_KEY_PART_SEPARATOR}${fields.join(CACHE_KEY_LIST_SEPARATOR)}${CACHE_KEY_PART_SEPARATOR}${anchors.join(
    CACHE_KEY_PART_SEPARATOR,
  )}${CACHE_KEY_PART_SEPARATOR}${kinds
    .map((accepted) => accepted.join(CACHE_KEY_LIST_SEPARATOR))
    .join(CACHE_KEY_PART_SEPARATOR)}`;
  const cachedBlock = blocks.get(contentIndex)?.get(key);
  if (cachedBlock !== undefined) return cachedBlock;
  let result = checks.get(contentIndex)?.get(key);

  if (result === undefined) {
    const inspected = await api.inspectTextAnchors({
      source,
      anchors,
      kinds,
      cwd: context.cwd,
      ...(context.signal !== undefined && { signal: context.signal }),
    });
    const contentChecks =
      checks.get(contentIndex) ?? new Map<string, TextAnchorInspectionOutcome>();
    contentChecks.set(key, inspected);
    checks.set(contentIndex, contentChecks);
    result = inspected;
  }

  if (result.kind === "valid") {
    return undefined;
  }

  if (result.kind === "failed") {
    return makeResolverBlockResult(
      context.toolCall.name,
      source,
      result.reason,
      result.cause instanceof ResourceError ? result.cause.code : undefined,
    );
  }

  // This interceptor owns stale snapshot failures only. Missing, ambiguous, and
  // invalid anchors continue to the mutation tool for their resolver-owned message.
  if (result.rejectionCode !== "stale") {
    return undefined;
  }

  const anchorIndex = result.anchorIndex;
  const details: StaleAnchorMessageDetails = {
    guardId: "stale-anchor",
    effect: "not-applied",
    toolName: context.toolCall.name,
    field: requiredValue(fields[anchorIndex]),
    path: source,
    anchor: requiredValue(anchors[anchorIndex]),
    ...(context.partialArgs !== undefined && { stoppedEarly: true }),
  };

  const block = makeBlockResult(details, result.reason);
  const contentBlocks = blocks.get(contentIndex) ?? new Map<string, InterceptResult>();
  contentBlocks.set(key, block);
  blocks.set(contentIndex, contentBlocks);
  return block;
}

function makeResolverBlockResult(
  toolName: string,
  source: string,
  reason: string,
  code?: string,
): InterceptResult {
  return {
    annotation: { kind: "blocked", reason },
    message: {
      customType: "text-editor-resolver-block",
      content: `[SYSTEM] ${toolName} blocked: ${reason}`,
      display: false,
      details: {
        guardId: "resolver",
        effect: "not-applied",
        ...(code === undefined ? {} : { code }),
        toolName,
        source,
        reason,
      },
    },
  };
}

function makeBlockResult(details: StaleAnchorMessageDetails, reason: string): InterceptResult {
  return {
    annotation: { kind: "stale-anchor" },
    message: {
      customType: "text-editor-stale-anchor-block",
      content: formatStaleAnchorMessage(details, reason),
      display: false,
      details,
    },
  };
}

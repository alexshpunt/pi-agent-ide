import { requiredValue } from "../../../../utils/required-value.js";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import {
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadPlugin,
  type ReadPluginApi,
} from "pi-agent-read/api/plugin-protocol";
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
import type { TextMutationToolRegistration } from "pi-agent-text-editor/api/mutation-tool";

const CACHE_KEY_PART_SEPARATOR = "\u{0}";
const CACHE_KEY_LIST_SEPARATOR = "\u{1}";

export default async function registerTextEditorStaleAnchor(pi: ExtensionAPI): Promise<void> {
  let readApi: ReadPluginApi | undefined;
  const readPlugin = {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "text-editor-stale-anchor",
    setup(api) {
      readApi = api;
    },
  } satisfies ReadPlugin;
  const editorPlugin = {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "text-editor-stale-anchor",
    setup(api) {
      const dynamic = createHandler(pi, api, () => {
        if (readApi === undefined) {
          throw new Error("pi-agent-read is unavailable");
        }

        return readApi;
      });
      registerToolCallInterceptor(pi, dynamic.handler);
      api.onMutationTool(dynamic.add);
    },
  } satisfies TextEditorPlugin;

  await Promise.all([connectReadPlugin(pi, readPlugin), connectTextEditorPlugin(pi, editorPlugin)]);
}

function createHandler(
  pi: ExtensionAPI,
  api: TextEditorPluginApi,
  getReadApi: () => ReadPluginApi,
): {
  readonly handler: ToolCallInterceptorHandler;
  readonly add: (registration: TextMutationToolRegistration) => void;
} {
  const schemas = new Map<string, TextMutationToolRegistration>();
  const toolNames: string[] = [];
  const knownPaths = new Map<number, string>();
  const checks = new Map<number, Map<string, TextAnchorInspectionOutcome>>();

  const handler: ToolCallInterceptorHandler = {
    name: "text-editor-stale-anchor-inspection",
    blockExecution: true,
    toolNames,
    async intercept(context) {
      const schema = schemas.get(context.toolCall.name);

      if (schema === undefined) {
        return;
      }

      const arguments_ = context.partialArgs ?? context.args;
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

      const pairBlock = await inspectAnchorPair(
        api,
        getReadApi(),
        context,
        schema,
        arguments_,
        source,
        checks,
      );

      if (pairBlock !== undefined) {
        return pairBlock;
      }

      const paired =
        schema.pair?.every((field) => typeof arguments_[field] === "string") === true
          ? new Set(schema.pair)
          : new Set<string>();

      for (const descriptor of schema.anchors ?? []) {
        if (paired.has(descriptor.field)) {
          continue;
        }

        const anchor = arguments_[descriptor.field];

        if (typeof anchor !== "string") {
          continue;
        }

        const candidateSource = arguments_[descriptor.sourceField];
        const anchorSource = typeof candidateSource === "string" ? candidateSource : source;
        const block = await inspectAnchors(
          api,
          getReadApi(),
          context,
          descriptor.field,
          anchorSource,
          [anchor],
          [descriptor.kinds],
          checks,
        );

        if (block !== undefined) {
          return block;
        }
      }

      return;
    },
    onContentEnd(contentIndex) {
      checks.delete(contentIndex);
    },
    onAbort(contentIndex) {
      checks.delete(contentIndex);
      knownPaths.delete(contentIndex);
    },
    onAgentEnd() {
      checks.clear();
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
  readApi: ReadPluginApi,
  context: InterceptorContext,
  schema: TextMutationToolRegistration,
  arguments_: Record<string, unknown>,
  source: string,
  checks: Map<number, Map<string, TextAnchorInspectionOutcome>>,
): Promise<InterceptResult | undefined> {
  if (schema.pair === undefined) {
    return undefined;
  }

  const [startField, endField] = schema.pair;
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

  return inspectAnchors(
    api,
    readApi,
    context,
    endField,
    source,
    [start, end],
    [startDescriptor.kinds, endDescriptor.kinds],
    checks,
  );
}

async function inspectAnchors(
  api: TextEditorPluginApi,
  readApi: ReadPluginApi,
  context: InterceptorContext,
  field: string,
  source: string,
  anchors: readonly [string] | readonly [string, string],
  kinds: readonly [readonly string[]] | readonly [readonly string[], readonly string[]],
  checks: Map<number, Map<string, TextAnchorInspectionOutcome>>,
): Promise<InterceptResult | undefined> {
  const contentIndex = context.contentIndex ?? -1;
  const key = `${source}${CACHE_KEY_PART_SEPARATOR}${anchors.join(
    CACHE_KEY_PART_SEPARATOR,
  )}${CACHE_KEY_PART_SEPARATOR}${kinds
    .map((accepted) => accepted.join(CACHE_KEY_LIST_SEPARATOR))
    .join(CACHE_KEY_PART_SEPARATOR)}`;
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
    return makeResolverBlockResult(context.toolCall.name, source, result.reason);
  }

  if (context.partialArgs !== undefined && result.reason === "anchor has invalid format") {
    return undefined;
  }

  const anchorIndex = result.anchorIndex;
  const readResult =
    result.contextRange === undefined
      ? undefined
      : await readApi.read(
          { path: source, ...result.contextRange },
          {
            cwd: context.cwd,
            ...(context.signal !== undefined && { signal: context.signal }),
          },
        );
  const readContext = readResult?.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const details: StaleAnchorMessageDetails = {
    guardId: "stale-anchor",
    effect: "not-applied",
    toolName: context.toolCall.name,
    field,
    path: source,
    anchor: requiredValue(anchors[anchorIndex]),
    ...(!(readContext === undefined || readContext.length === 0) && { context: readContext }),
  };

  return makeBlockResult(details, result.reason);
}

function makeResolverBlockResult(
  toolName: string,
  source: string,
  reason: string,
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

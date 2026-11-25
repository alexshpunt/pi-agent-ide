import {
  createJqReadHandler,
  type ReadHandler,
  type ReadPipelineContext,
  type ReadPluginApi,
} from "pi-agent-ide/api/read";
import type { AgentContent } from "pi-agent-ide/api/resource";

interface JsonInput {
  readonly input: string;
  readonly coverage?: string;
}
export interface LinearJsonSnapshot {
  readonly content: string;
}
export type LinearJsonCapture = (value: unknown, coverage?: string) => void;

// Acquisition identity, not a URI cache: simultaneous reads cannot exchange payloads.
const inputs = new WeakMap<object, JsonInput>();
const transformedCoverage = new WeakMap<object, string>();

/** Retain the acquired value immediately, before a backend or caller can mutate it. */
// JSON.stringify returns undefined for values without a JSON representation.
function stringifyJson(value: unknown, indentation?: number): string | undefined {
  return JSON.stringify(value, null, indentation);
}

export function withLinearJson<T extends object>(
  snapshot: T,
  value: unknown,
  coverage?: string,
): T {
  const input: string | undefined = stringifyJson(value);
  if (input !== undefined) inputs.set(snapshot, Object.freeze({ input, coverage }));
  else inputs.delete(snapshot);
  return snapshot;
}

export function linearJsonSnapshot(
  value: unknown,
  content: string | undefined = stringifyJson(value, 2),
  coverage?: string,
): LinearJsonSnapshot {
  return withLinearJson(Object.freeze({ content: content ?? "" }), value, coverage);
}

/** Preserve advertised page metadata even when a jq filter removes it. */
export function linearApiPageCoverage(
  value: unknown,
  source: string,
  acceptsCursor: boolean,
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const root = value as Record<string, unknown>;
  const info =
    root.pageInfo && typeof root.pageInfo === "object" && !Array.isArray(root.pageInfo)
      ? (root.pageInfo as Record<string, unknown>)
      : root;
  const more = info.hasNextPage ?? info.hasMore;
  if (more === false) return "End of API results.";
  if (more !== true) return;
  const cursor = info.endCursor ?? info.cursor ?? info.nextCursor;
  if (
    !acceptsCursor ||
    typeof cursor !== "string" ||
    !cursor ||
    cursor.length > 1024 ||
    /[\r\n]/u.test(cursor)
  )
    return "Coverage: this page only. The API reports more results without a verified continuation route.";
  const next = new URL(source);
  next.searchParams.set("cursor", cursor);
  return `Coverage: this page only.\nNext page: ${next.href}`;
}

/** Associate JSON with the actual block that the shared Read pipeline acquires. */
export function linearJsonContent(snapshot: LinearJsonSnapshot): AgentContent {
  const block = { type: "text" as const, text: snapshot.content };
  const input = inputs.get(snapshot);
  if (input) inputs.set(block, input);
  return [block];
}

/** Keep existing string readers while capturing their JSON in this invocation only. */
export async function captureLinearJson(
  read: (capture: LinearJsonCapture) => Promise<string>,
): Promise<AgentContent> {
  const acquisition = {};
  const content = await read((value, coverage) => {
    withLinearJson(acquisition, value, coverage);
  });
  const block = { type: "text" as const, text: content };
  const input = inputs.get(acquisition);
  if (input) inputs.set(block, input);
  return [block];
}

function owns(resolvedBy: string): boolean {
  return [
    "linear",
    "linear-domain",
    "linear-fields",
    "linear-collections",
    "linear-text",
    "linear-comment-body",
    "linear-asset",
    "linear-artifacts",
  ].includes(resolvedBy);
}

export const linearJsonRead: ReadHandler = (() => {
  const jq = createJqReadHandler({
    pluginId: "linear-jq",
    input: (context: ReadPipelineContext) => {
      const block = context.state?.content[0];
      return block && inputs.get(block)?.input;
    },
  });
  return async (context) => {
    if (!context.state || !owns(context.state.resolvedBy)) return { kind: "continue", context };
    const before = context.state.content.at(0);
    const outcome = await jq(context);
    if (outcome.kind === "continue") {
      const after = outcome.context.state?.content.at(0);
      const coverage = before && inputs.get(before)?.coverage;
      if (after && after !== before && coverage) transformedCoverage.set(after, coverage);
    }
    return outcome;
  };
})();

/** Page coverage is presentation, never mixed into jq's canonical JSON stream. */
export const linearJsonCoverage: ReadHandler = (context) => {
  const block = context.state?.content[0];
  const coverage = block && transformedCoverage.get(block);
  if (!coverage || context.result?.isError) return { kind: "continue", context };
  return {
    kind: "continue",
    context,
    transform: (result) => {
      if (result.isError) return result;
      const lines = result.details.lines ?? [];
      const first = lines.at(0);
      const rest = lines.slice(1);
      return {
        ...result,
        content: [...result.content, { type: "text", text: coverage }],
        details: {
          ...result.details,
          // The panel renders presented lines, not supplemental content. Keep the
          // notice on its first visible row; do not alter canonical script lines.
          // Empty output has no rows, so let the panel render the notice content.
          lines: first
            ? [
                {
                  ...first,
                  presentation: {
                    ...first.presentation,
                    before: [
                      ...(first.presentation?.before ?? []),
                      ...coverage.split("\n").map((content) => ({ content })),
                    ],
                  },
                },
                ...rest,
              ]
            : undefined,
        },
      };
    },
  };
};

export function registerLinearJsonViews(api: ReadPluginApi): void {
  api.addView({ view: "jq", presenter: { id: "linear-jq", present: (document) => document } });
  api.addHandler({
    stage: "read",
    when: { resolvedBy: "any", contentKind: "any" },
    handler: linearJsonRead,
  });
  api.addHandler({ stage: "post-read", handler: linearJsonCoverage });
  api.describe({
    views:
      "Structured Linear cards, typed fields and acquired API pages support jq:<filter>; see docs:linear-discovery. Body text and assets are unsupported. Jq output grants no edit authority; bounded result/anchor inputs are refused.",
  });
}

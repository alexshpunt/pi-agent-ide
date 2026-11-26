import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResourceResolver } from "pi-agent-ide/api/resource";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";
import {
  connectSearchPlugin,
  SEARCH_API_VERSION,
  SEARCH_PROTOCOL,
  type SearchResolver,
} from "pi-agent-ide/api/search";
import {
  ensureResults,
  findSession,
  resourceSource,
  resultLine,
  sessionIdOf,
} from "./result-store.ts";

/** Results shown by a Read that names `offset` but no `limit`. */
const DEFAULT_PAGE_SIZE = 10;

const resolver: ResourceResolver = {
  id: "web-search-results",
  async tryResolve(source) {
    const id = sessionIdOf(source);
    if (id === undefined) return { kind: "not-handled" };
    const session = findSession(id);
    if (!session)
      return {
        kind: "failed",
        error: new Error(
          `Unknown search resource ${source}. Search results live only as long as the Pi process; run the search again.`,
        ),
      };
    return {
      kind: "resolved",
      resource: {
        source,
        read: async () => [
          {
            type: "text",
            text: session.items.map((item, index) => resultLine(index + 1, item)).join("\n"),
          },
        ],
      },
    };
  },
};

/** Finds literal text (case-insensitive unless asked otherwise) or a `regex:` pattern in the saved result lines. */
function matchingLines(
  lines: string[],
  request: { query: string; caseSensitive?: boolean; wholeWord?: boolean },
): string[] {
  const query = request.query.trim();
  const flags = request.caseSensitive ? "u" : "iu";
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    query.startsWith("regex:")
      ? query.slice("regex:".length)
      : request.wholeWord
        ? `\\b${escaped}\\b`
        : escaped,
    flags,
  );
  return lines.filter((line) => pattern.test(line));
}

const searchResolver: SearchResolver = {
  id: "web-search-results",
  tryResolve(request) {
    const id = request.path ? sessionIdOf(request.path) : undefined;
    if (id === undefined) return { kind: "not-handled" };
    const session = findSession(id);
    if (!session)
      return {
        kind: "failed",
        error: new Error(
          `Unknown search resource ${request.path}. Search results live only as long as the Pi process; run the search again.`,
        ),
      };
    return { kind: "resolved", payload: { session, request } };
  },
  toScriptData: (_payload, details) => ({
    kind: "custom",
    resolverId: "web-search-results",
    value: details,
  }),
  format(payload) {
    const { session, request } = payload as {
      session: NonNullable<ReturnType<typeof findSession>>;
      request: { query: string; caseSensitive?: boolean; wholeWord?: boolean; limit?: number };
    };
    const lines = session.items.map((item, index) => resultLine(index + 1, item));
    const found = matchingLines(lines, request).slice(0, request.limit ?? 50);
    const text = found.length
      ? found.join("\n")
      : `No saved result of ${resourceSource(session)} matches. Only the ${lines.length} saved results are searched; Read the resource past them to fetch more.`;
    return { content: [{ type: "text", text }], details: { matches: found.length } };
  },
};

let connected = false;
/** True once Pi Agent IDE's Read has accepted the plugin, so result resources can be read. */
export function resultsResourceAvailable(): boolean {
  return connected;
}

/**
 * Registers `websearch:<id>` with Pi Agent IDE when shared Read and Search are available.
 */
export async function connectResultsResource(pi: ExtensionAPI): Promise<void> {
  await connectSearchPlugin(pi, {
    protocol: SEARCH_PROTOCOL,
    apiVersion: SEARCH_API_VERSION,
    id: "pi-web-search",
    setup(searchPluginApi) {
      searchPluginApi.addResolver({ resolver: searchResolver, priority: -100 });
    },
  });
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "pi-web-search",
    setup(readApi) {
      readApi.addResolver({ resolver });
      // A Read that reaches past the saved results first fetches the missing pages from Serper.
      readApi.addHandler({
        stage: "pre-read",
        async handler(context) {
          const id = context.request.path ? sessionIdOf(context.request.path) : undefined;
          const session = id === undefined ? undefined : findSession(id);
          if (!session) return { kind: "continue", context };
          const offset = context.request.offset ?? 1;
          if (offset > 0)
            await ensureResults(
              session,
              offset - 1 + (context.request.limit ?? DEFAULT_PAGE_SIZE),
              context.resolverContext.signal,
            );
          return { kind: "continue", context };
        },
      });
      readApi.describe({
        path: "Also reads `websearch:<id>` search results. One line per result: Read with offset N and limit L shows results N to N+L-1 and fetches further pages when needed.",
      });
      connected = true;
    },
  });
}

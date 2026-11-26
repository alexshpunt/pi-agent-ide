import type { SearchResolver } from "pi-agent-ide/api/search";
import { parseCatalogAddress, searchCatalog, type UnityTool } from "./catalog.ts";

type Reader = (source: string, signal?: AbortSignal) => Promise<string>;
type CatalogReader = (project: string, signal?: AbortSignal) => Promise<UnityTool[]>;
type TextPage = {
  mode: "text";
  source: string;
  matches: { line: number; text: string }[];
  complete: boolean;
};
type CatalogPage = {
  mode: "catalog";
  source: string;
  items: ReturnType<typeof searchCatalog>["items"];
  complete: boolean;
};
type Page = TextPage | CatalogPage;

/** Search an explicit Unity resource or a project-scoped tool catalog. */
export function createUnitySearch(
  read: Reader,
  readCatalog?: CatalogReader,
  register?: (tool: UnityTool) => void,
): SearchResolver {
  return {
    id: "unity",
    async tryResolve(request, context) {
      if (!request.path?.startsWith("unity:")) return { kind: "not-handled" };
      try {
        if (
          context.scope ||
          request.include ||
          request.exclude ||
          request.wholeWord ||
          request.query.startsWith("regex:")
        ) {
          throw new Error(
            "Unity URI search supports literal text only; read a resource for scoped or regex search.",
          );
        }
        if (!request.query || request.query.length > 4096)
          throw new Error("Provide a non-empty search query of at most 4096 characters.");
        const limit = Math.min(request.limit ?? 50, 100);
        if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid search limit.");
        const address = parseCatalogAddress(request.path);
        if (address && !address.name && readCatalog) {
          if (request.caseSensitive) throw new Error("Unity catalog search is case-insensitive.");
          const tools = await readCatalog(address.project, context.signal);
          const page = searchCatalog(address.project, tools, request.query, limit);
          for (const item of page.items) {
            const matches = tools.filter((tool) => tool.name === item.name);
            if (matches.length === 1) register?.(matches[0]);
          }
          return {
            kind: "resolved",
            payload: { mode: "catalog", source: request.path, ...page } satisfies CatalogPage,
          };
        }
        const content = await read(request.path, context.signal);
        const needle = request.caseSensitive ? request.query : request.query.toLowerCase();
        const matches: TextPage["matches"] = [];
        let complete = true;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          context.signal?.throwIfAborted();
          const line = lines[i];
          if (!(request.caseSensitive ? line : line.toLowerCase()).includes(needle)) continue;
          if (matches.length === limit) {
            complete = false;
            break;
          }
          matches.push({ line: i + 1, text: line });
        }
        return {
          kind: "resolved",
          payload: { mode: "text", source: request.path, matches, complete } satisfies TextPage,
        };
      } catch (error) {
        context.signal?.throwIfAborted();
        return { kind: "failed", error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
    format(value) {
      const page = value as Page;
      const lines =
        page.mode === "catalog"
          ? [
              `${page.items.length}${page.complete ? "" : "+"} matching Unity tools`,
              ...page.items.map((item) => `${item.name}: ${item.description ?? ""} <${item.uri}>`),
            ]
          : [
              `${page.matches.length}${page.complete ? "" : "+"} matches in ${page.source}`,
              ...page.matches.map((m) => `${page.source}:${m.line} ${m.text}`),
            ];
      if (!page.complete) lines.push("Coverage is incomplete.");
      return { content: [{ type: "text", text: lines.join("\n") }], details: page };
    },
    toScriptData(value) {
      return { kind: "custom", resolverId: "unity", value };
    },
  };
}

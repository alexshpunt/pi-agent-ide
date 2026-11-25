import { parseFlags, usage } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import { asArray, callAvailableTool, extractData } from "#axi/lib/mcp-tools.ts";
import { resourceOperationCommand } from "./resource-operations.ts";
import { childrenCommand } from "./children.ts";
import { searchScopeCommand } from "./search-scope.ts";
import { asRecord, isRecord, isUnknownArray, type InputRecord, type Runtime } from "#axi/types.ts";
import { valueText } from "#axi/lib/value-text.ts";
import { optionalText } from "./command-input.ts";

// Each entry is a confirmed read-only MCP operation, not a user-selected tool name.
const LISTS = {
  teams: { tool: "list_teams", query: "query", parent: undefined, paginated: true },
  users: { tool: "list_users", query: "query", parent: "team", paginated: true },
  labels: { tool: "list_issue_labels", query: "name", parent: "team", paginated: true },
  cycles: { tool: "list_cycles", query: undefined, parent: "teamId", paginated: false },
  statuses: { tool: "list_issue_statuses", query: undefined, parent: "team", paginated: false },
  milestones: { tool: "list_milestones", query: undefined, parent: "project", paginated: false },
  releases: { tool: "list_releases", query: "query", parent: undefined, paginated: true },
  views: { tool: "list_custom_views", query: "query", parent: "team", paginated: true },
} as const;
const GETS = {
  teams: { tool: "get_team", key: "query" },
  users: { tool: "get_user", key: "query" },
  releases: { tool: "get_release", key: "id" },
  attachments: { tool: "get_attachment", key: "id" },
} as const;

function object(value: unknown): InputRecord {
  if (!isRecord(value)) throw new Error("LINEAR_INVALID_RESPONSE");
  return value;
}

function ownEntry<T extends object>(entries: T, name: string): T[keyof T] | undefined {
  return Object.hasOwn(entries, name) ? entries[name as keyof T] : undefined;
}

async function readTool(runtime: Runtime, name: string, args: Record<string, unknown>) {
  try {
    const result = await callAvailableTool(runtime, [name], args);
    if (result.isError) throw new Error("LINEAR_RESOURCE_FAILED");
    return extractData(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/OAuth authorization required|authentication required|unauthorized/iu.test(message))
      throw new Error("LINEAR_AUTH_REQUIRED", { cause: error });
    if (error && typeof error === "object" && "toolUnavailable" in error)
      throw new Error("LINEAR_RESOURCE_UNSUPPORTED", { cause: error });
    throw new Error("LINEAR_RESOURCE_FAILED", { cause: error });
  }
}
/** Bounded API directory lookup and explicit resource reads using the existing MCP authorization. */
export async function resourceCommand(args: string[], runtime: Runtime): Promise<string> {
  if (args[0] === "children") return childrenCommand(args.slice(1), runtime);
  if (args[0] === "scope") return searchScopeCommand(args.slice(1), runtime);
  if (args[0] === "capabilities" || args[0] === "invoke")
    return resourceOperationCommand(args, runtime);
  const parsed = parseFlags(args, {
    boolean: ["help"],
    example: "resources list teams --query ENG --workspace example",
  });
  if (parsed.help)
    return "usage: linear-axi resources <list|view> <teams|users|labels|cycles|statuses|milestones|releases|views|attachments> [id] --workspace <slug> [--query <text>] [--scope <parent>] [--limit 50] [--cursor <cursor>]\nusage: linear-axi resources capabilities --workspace <slug>\nusage: linear-axi resources invoke <approved-operation> --workspace <slug> --input-file <local-json-file>\ndescription: List/view are read-only API directories, not global full-text search. Cycles/statuses require a team; milestones require a project. Capabilities/invoke are internal schema-validated provider transport; the caller owns approval and resource verification.\n";
  const [action, kind, id] = parsed.positionals;
  const workspace = optionalText(parsed.workspace);
  const cursorFlag = optionalText(parsed.cursor);
  const scope = optionalText(parsed.scope);
  const query = optionalText(parsed.query);
  const allowed = new Set([
    "positionals",
    "help",
    "workspace",
    "query",
    "scope",
    "limit",
    "cursor",
  ]);
  if (
    (action !== "list" && action !== "view") ||
    !Object.keys(parsed).every((key) => allowed.has(key)) ||
    workspace === undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(workspace) ||
    parsed.positionals.length > (action === "view" ? 3 : 2)
  )
    throw usage("invalid resource query");
  const config = ownEntry(LISTS, kind);
  const get = ownEntry(GETS, kind);
  if (!config && !(action === "view" && get)) throw new Error("LINEAR_RESOURCE_UNSUPPORTED");
  const first = parsed.limit === undefined ? 50 : Number(parsed.limit);
  if (
    !Number.isInteger(first) ||
    first < 1 ||
    first > 50 ||
    (parsed.cursor !== undefined &&
      (!cursorFlag || cursorFlag.length > 1024 || /[\r\n]/u.test(cursorFlag)))
  )
    throw usage("invalid resource pagination");
  // Verify this principal's workspace before using any UUID supplied by another provider.
  const owner = object(await readTool(runtime, "get_workspace", {}));
  if (owner.url !== `https://linear.app/${workspace}`) throw new Error("LINEAR_IDENTITY_MISMATCH");
  if (action === "view" && get) {
    if (!id) throw usage("resource id is required");
    const detail = object(
      await readTool(runtime, get.tool, {
        [get.key]: id,
        ...(kind === "attachments" ? { format: "url" } : {}),
      }),
    );
    if (kind !== "attachments" && detail.id !== id) throw new Error("LINEAR_IDENTITY_MISMATCH");
    return renderToon({
      resource: { workspace, kind, data: JSON.stringify(detail) },
    });
  }
  if (!config) throw new Error("LINEAR_RESOURCE_UNSUPPORTED");
  if (["cycles", "statuses", "milestones"].includes(kind) && !scope)
    throw new Error("LINEAR_PARENT_SCOPE_REQUIRED");
  if (!config.paginated && cursorFlag) throw usage("this directory does not accept a cursor");
  const data = await readTool(runtime, config.tool, {
    ...(config.paginated ? { limit: first, ...(cursorFlag ? { cursor: cursorFlag } : {}) } : {}),
    ...(config.query && query ? { [config.query]: query } : {}),
    ...(config.parent && scope ? { [config.parent]: scope } : {}),
  });
  const info = isUnknownArray(data) ? {} : object(data);
  const custom = isUnknownArray(info.releases)
    ? info.releases
    : isUnknownArray(info.customViews)
      ? info.customViews
      : undefined;
  const rows = custom === undefined ? asArray(data) : custom.map(object);
  const pageInfo = asRecord(info.pageInfo);
  const cursor = info.endCursor ?? info.cursor ?? pageInfo?.endCursor;
  const hasMore = info.hasNextPage ?? pageInfo?.hasNextPage ?? false;
  if (
    typeof hasMore !== "boolean" ||
    (hasMore && (typeof cursor !== "string" || !cursor || cursor === cursorFlag))
  )
    throw new Error("LINEAR_INVALID_RESPONSE");
  if (action === "view") {
    const detail = rows.find((row) => row.id === id);
    if (!detail)
      throw new Error(
        hasMore || rows.length > first ? "LINEAR_LOOKUP_INCOMPLETE" : "LINEAR_NOT_FOUND",
      );
    return renderToon({
      resource: { workspace, kind, data: JSON.stringify(detail) },
    });
  }
  // Unfiltered parent lists are matched only within this returned page, with explicit coverage.
  const matching =
    config.query || !query
      ? rows
      : rows.filter((row) =>
          valueText(row.name ?? row.title ?? "")
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        );
  return renderToon({
    directory: {
      workspace,
      kind,
      items: matching.slice(0, first).map((row) => ({
        id: row.id,
        title: row.name ?? row.title ?? row.key,
        ...(typeof row.url === "string" ? { url: row.url } : {}),
      })),
      hasMore: hasMore || matching.length > first,
      ...(hasMore ? { cursor } : {}),
      coverage: config.query
        ? "API directory query; searched fields follow the backend contract, not full text."
        : "Name matches within the returned parent list only.",
    },
  });
}

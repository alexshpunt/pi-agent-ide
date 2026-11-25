import { parseFlags, usage } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import { asArray, callAvailableTool, extractData } from "#axi/lib/mcp-tools.ts";
import { asRecord, type Runtime } from "#axi/types.ts";
import { optionalText } from "./command-input.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** Resolve against the complete selected project directory, never a global name search. */
async function resolveMilestone(
  runtime: Runtime,
  workspace: string,
  project: string,
  reference: string,
): Promise<string> {
  const read = async (name: string, input: Record<string, unknown>) => {
    try {
      const result = await callAvailableTool(runtime, [name], input);
      if (result.isError) throw new Error("LINEAR_RESOURCE_FAILED");
      return extractData(result);
    } catch {
      throw new Error("LINEAR_RESOURCE_FAILED");
    }
  };
  const owner = asRecord(await read("get_workspace", {}));
  if (owner?.url !== `https://linear.app/${workspace}`) throw new Error("LINEAR_IDENTITY_MISMATCH");
  const data = await read("list_milestones", { project });
  const envelope = asRecord(data);
  const more = envelope?.hasNextPage ?? asRecord(envelope?.pageInfo)?.hasNextPage;
  if (more !== undefined && more !== false) throw new Error("LINEAR_LOOKUP_INCOMPLETE");
  const rows = asArray(data).map(({ id, name }) => {
    if (typeof id !== "string" || !uuid.test(id) || typeof name !== "string")
      throw new Error("LINEAR_INVALID_RESPONSE");
    return { id, name };
  });
  const matches = rows.filter((row) =>
    uuid.test(reference)
      ? row.id.toLowerCase() === reference.toLowerCase()
      : row.name.toLowerCase() === reference.toLowerCase(),
  );
  if (matches.length === 0) throw new Error("LINEAR_NOT_FOUND");
  if (matches.length !== 1) throw new Error("LINEAR_AMBIGUOUS_REFERENCE");
  return matches[0].id.toLowerCase();
}

/** Search native Linear objects with the app authorization, without repo binding defaults. */
export async function searchCommand(args: string[], runtime: Runtime): Promise<string> {
  const parsed = parseFlags(args, {
    boolean: ["help", "include-comments", "include-archived"],
    example: 'search issues --query "SSH" --workspace example',
  });
  if (parsed.help)
    return `usage: linear-axi search <issues|projects|documents> --query <text> --workspace <slug> [--limit 50] [--cursor <cursor>] [--team-id <UUID>] [--project-id <UUID>] [--parent-id <UUID>] [--milestone <UUID|name>] [--include-comments] [--include-archived]\ndescription: Native GraphQL full-text search. Project/document scopes are post-filtered; totals are native totals before filtering.\n`;
  const [kind] = parsed.positionals;
  const { query, workspace, milestone, "parent-id": parentId } = parsed;
  const projectId = optionalText(parsed["project-id"]);
  if (
    (kind !== "issues" && kind !== "projects" && kind !== "documents") ||
    parsed.positionals.length !== 1 ||
    typeof query !== "string" ||
    !query ||
    typeof workspace !== "string" ||
    !workspace
  )
    throw usage("search requires a kind, --query and --workspace", [
      "Run `linear-axi search --help`",
    ]);
  const allowed = new Set([
    "positionals",
    "help",
    "query",
    "workspace",
    "limit",
    "cursor",
    "team-id",
    "project-id",
    "parent-id",
    "milestone",
    "include-comments",
    "include-archived",
  ]);
  if (Object.keys(parsed).some((key) => !allowed.has(key)))
    throw usage("unsupported search flag", ["Run `linear-axi search --help`"]);
  if (
    parentId !== undefined &&
    (kind !== "issues" || typeof parentId !== "string" || !uuid.test(parentId))
  )
    throw usage("parent scope requires issues and a canonical parent UUID", [
      "Resolve the parent issue before native search.",
    ]);
  let milestoneId: string | undefined;
  if (milestone !== undefined) {
    if (
      kind !== "issues" ||
      projectId === undefined ||
      !uuid.test(projectId) ||
      typeof milestone !== "string" ||
      !milestone.trim() ||
      milestone.length > 4096
    )
      throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
    if (!runtime.searchClient) throw new Error("LINEAR_GRAPHQL_AUTH_REQUIRED");
    milestoneId = await resolveMilestone(runtime, workspace, projectId, milestone);
  }
  if (!runtime.searchClient) throw new Error("LINEAR_GRAPHQL_AUTH_REQUIRED");
  return renderToon({
    search: await runtime.searchClient.searchObjects({
      kind,
      term: query,
      workspace,
      limit: parsed.limit === undefined ? 50 : Number(parsed.limit),
      cursor: optionalText(parsed.cursor),
      teamId: optionalText(parsed["team-id"]),
      projectId,
      parentId,
      milestoneId,
      includeComments: Boolean(parsed["include-comments"]),
      includeArchived: Boolean(parsed["include-archived"]),
    }),
  });
}

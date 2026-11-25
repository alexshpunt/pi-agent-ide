import { parseFlags, usage } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import { callAvailableTool, extractData } from "#axi/lib/mcp-tools.ts";
import { mcpToolFailure } from "#axi/lib/mcp-error.ts";
import { isRecord, type Runtime } from "#axi/types.ts";
import { verifyWorkspace } from "./resource-operations.ts";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;
type ScopeKind = "project" | "team";
interface ScopeIdentity {
  id: string;
  url?: string;
  key?: string;
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("LINEAR_INVALID_RESPONSE");
  return value;
}
function identity(
  data: unknown,
  kind: ScopeKind,
  reference: string,
  workspace: string,
): ScopeIdentity {
  const row = record(data);
  const id = typeof row.id === "string" && uuid.test(row.id) ? row.id : row.uuid;
  if (typeof id !== "string" || !uuid.test(id)) throw new Error("LINEAR_INVALID_RESPONSE");
  const result: ScopeIdentity = { id: id.toLowerCase() };
  if (kind === "project") {
    if (typeof row.url !== "string") throw new Error("LINEAR_INVALID_RESPONSE");
    let url: URL;
    try {
      url = new URL(row.url);
    } catch {
      throw new Error("LINEAR_INVALID_RESPONSE");
    }
    const match = /^\/([^/]+)\/project\/([^/]+)(?:\/overview)?\/?$/u.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "linear.app" ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      url.search ||
      !match ||
      match[1] !== workspace ||
      !(uuid.test(reference)
        ? id.toLowerCase() === reference.toLowerCase()
        : match[2] === reference ||
          (/^[0-9a-f]{12}$/iu.test(reference) && match[2].endsWith("-" + reference)))
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    result.url = url.href;
  } else {
    if (
      typeof row.key !== "string" ||
      !row.key ||
      !(uuid.test(reference)
        ? id.toLowerCase() === reference.toLowerCase()
        : row.key.toLowerCase() === reference.toLowerCase())
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    result.key = row.key;
  }
  return result;
}

/** Internal search metadata only; full cards and pre-save resource state remain uncached. */
export async function searchScopeCommand(args: string[], runtime: Runtime): Promise<string> {
  const parsed = parseFlags(args, {
    boolean: [],
    example: "resources scope project <id> --workspace <slug>",
  });
  const [kind, reference] = parsed.positionals;
  const { workspace } = parsed;
  if (
    (kind !== "project" && kind !== "team") ||
    parsed.positionals.length !== 2 ||
    !/^[A-Za-z0-9_-]{1,256}$/u.test(reference) ||
    typeof workspace !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(workspace) ||
    Object.keys(parsed).some((key) => !["positionals", "workspace"].includes(key))
  )
    throw usage("invalid search scope");
  await verifyWorkspace(runtime, workspace);
  const load = async (): Promise<ScopeIdentity> => {
    const response = await callAvailableTool(runtime, ["get_" + kind], { query: reference });
    if (response.isError) throw mcpToolFailure("OPERATION", response);
    return identity(extractData(response), kind, reference, workspace);
  };
  const valid = (value: unknown): value is ScopeIdentity => {
    try {
      const row = record(value);
      if (Object.keys(row).some((key) => !["id", "url", "key"].includes(key))) return false;
      identity(row, kind, reference, workspace);
      return true;
    } catch {
      return false;
    }
  };
  const proof = runtime.preflightCache
    ? await runtime.preflightCache.get(
        "scope-identity:" + workspace + ":" + kind + ":" + reference,
        load,
        valid,
      )
    : await load();
  return renderToon({ [kind]: proof });
}

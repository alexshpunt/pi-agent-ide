import { parseFlags, usage } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import type { Runtime } from "#axi/types.ts";
import { optionalText } from "./command-input.ts";

/** Read direct children from native GraphQL, with no repo or search-term defaults. */
export async function childrenCommand(args: string[], runtime: Runtime): Promise<string> {
  const parsed = parseFlags(args, {
    boolean: ["help"],
    example: "resources children --workspace example --parent-id UUID",
  });
  if (parsed.help)
    return "usage: linear-axi resources children --workspace <slug> --parent-id <UUID> [--limit 50] [--cursor <cursor>]\n";
  const { workspace, "parent-id": parentId } = parsed;
  if (
    parsed.positionals.length ||
    typeof workspace !== "string" ||
    !workspace ||
    typeof parentId !== "string" ||
    !parentId ||
    Object.keys(parsed).some(
      (key) => !["positionals", "workspace", "parent-id", "limit", "cursor"].includes(key),
    )
  )
    throw usage("children requires workspace and parent-id; unsupported flags refuse");
  if (!runtime.searchClient?.listChildren) throw new Error("LINEAR_GRAPHQL_AUTH_REQUIRED");
  return renderToon({
    children: await runtime.searchClient.listChildren({
      workspace,
      parentId,
      limit: parsed.limit === undefined ? 50 : Number(parsed.limit),
      cursor: optionalText(parsed.cursor),
    }),
  });
}

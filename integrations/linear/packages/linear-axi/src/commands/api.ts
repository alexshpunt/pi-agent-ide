import { parseFlags, usage } from "#axi/args.ts";
import { RawGraphqlInputError } from "#axi/native-raw-graphql.ts";
import { readInput } from "./resource-operations.ts";
import type { Runtime } from "#axi/types.ts";

/** Raw native transport, not a new agent tool family or a per-operation catalog adapter. */
export async function apiCommand(args: string[], runtime: Runtime): Promise<string> {
  const parsed = parseFlags(args, {
    boolean: ["help"],
    example: "api graphql --workspace example --input-file request.json",
  });
  const { workspace } = parsed;
  if (parsed.help)
    return "usage: linear-axi api graphql --workspace <slug> --input-file <local-json-file>\n";
  if (
    parsed.positionals.length !== 1 ||
    parsed.positionals[0] !== "graphql" ||
    Object.keys(parsed).some((k) => !["positionals", "workspace", "input-file"].includes(k)) ||
    typeof workspace !== "string" ||
    !/^[A-Za-z0-9_-]+$/u.test(workspace)
  )
    throw usage("invalid raw GraphQL request");
  let input: unknown;
  try {
    input = await readInput(parsed["input-file"], runtime.cwd);
  } catch (error) {
    throw new RawGraphqlInputError(
      error instanceof Error && error.message === "LINEAR_INPUT_TOO_LARGE"
        ? "LINEAR_INPUT_TOO_LARGE"
        : "LINEAR_GRAPHQL_INPUT_INVALID",
    );
  }
  if (!runtime.searchClient?.executeGraphql)
    throw new RawGraphqlInputError("LINEAR_NATIVE_UNAVAILABLE");
  const receipt = await runtime.searchClient.executeGraphql(input, workspace);
  return JSON.stringify({ graphql: receipt });
}

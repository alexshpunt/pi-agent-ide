import { asRecord, type Runtime } from "#axi/types.ts";
import { valueText } from "#axi/lib/value-text.ts";
import { parseFlags, usage, AxiError } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import { callAvailableTool, extractData } from "#axi/lib/mcp-tools.ts";
import { projectMatches } from "#axi/lib/project-match.ts";
import { notFound } from "./shared.ts";

/** Read a full team/project card without falling back to truncated list data. */
export async function viewResourceCommand(
  resource: "team" | "project",
  args: string[],
  runtime: Runtime,
) {
  const plural = `${resource}s`;
  const parsed = parseFlags(args, { boolean: ["help", "full"], example: `${plural} view <id>` });
  if (parsed.help)
    return `usage: linear-axi ${plural} view <id> [--full]\ndescription: Read one ${resource} card. --full includes complete content and available resources.\n`;
  const id = parsed.positionals[0];
  if (!id)
    throw usage(`${resource} id is required`, [`Run \`linear-axi ${plural} view <id> --full\``]);
  const result = await callAvailableTool(runtime, [`get_${resource}`], {
    query: id,
    ...(resource === "project" ? { includeResources: true } : {}),
  });
  if (result.isError) throw new AxiError("operational", `Linear ${resource} read failed`);
  const detail = asRecord(extractData(result));
  const matches =
    resource === "project"
      ? projectMatches(detail, id)
      : [detail?.id, detail?.key, detail?.name].some(
          (value) =>
            typeof value === "string" && value.toLocaleLowerCase() === id.toLocaleLowerCase(),
        );
  if (!detail || !matches)
    throw notFound(resource, id, [`Run \`linear-axi ${plural} list\` to find the ${resource}`]);
  if (parsed.full) return renderToon({ [resource]: detail });
  const description = valueText(detail.description ?? "");
  const truncated = description.length > 1200;
  return renderToon({
    [resource]: {
      id: detail.id,
      ...(resource === "team" ? { key: detail.key } : {}),
      name: detail.name,
      summary: detail.summary,
      description: truncated
        ? `${description.slice(0, 1200)}... (truncated, ${description.length} chars total)`
        : description,
      url: detail.url,
    },
    ...(truncated
      ? {
          help: [`Run \`linear-axi ${plural} view ${id} --full\` to show the complete ${resource}`],
        }
      : {}),
  });
}

import type { Runtime } from "#axi/types.ts";
import { parseFlags } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import { dispatchCommandGroup, requireTeam } from "#axi/lib/cli-helpers.ts";
import { compactRows } from "#axi/lib/linear-format.ts";
import { extractData } from "#axi/lib/mcp-tools.ts";
import { cycleListHelp, groupHelp } from "./help.ts";

export async function cycleCommand(args: string[], runtime: Runtime) {
  return dispatchCommandGroup(args, {
    name: "cycles",
    help: () => groupHelp("cycles", ["list"]),
    handlers: {
      list: (rest) => listCyclesCommand(rest, runtime),
    },
    unknownHelp: ["Run `linear-axi cycles list --team <team-id>`"],
  });
}

async function listCyclesCommand(args: string[], runtime: Runtime) {
  const parsed = parseFlags(args, { boolean: ["help", "full"], example: "cycles list --team ENG" });
  if (parsed.help) return cycleListHelp();
  const teamId = requireTeam(parsed, ["Run `linear-axi cycles list --team <team-id>`"]);
  const result = await runtime.client.callTool("list_cycles", { teamId, type: parsed.type });
  return renderToon({
    cycles: parsed.full ? extractData(result) : compactRows("cycles", extractData(result)),
  });
}

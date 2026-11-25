import type { Runtime } from "#axi/types.ts";
import { parseFlags } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import {
  appendContinuationHelp,
  collectKnownArgs,
  dispatchCommandGroup,
  formatCommandArg,
  requireTeam,
} from "#axi/lib/cli-helpers.ts";
import { compactRows, paginationInfo } from "#axi/lib/linear-format.ts";
import { asArray, callAvailableTool, extractData } from "#axi/lib/mcp-tools.ts";
import { groupHelp, statusListHelp } from "./help.ts";

const STATUS_LIST_FIELDS = [
  "team",
  "teamId",
  "type",
  "project",
  "initiative",
  "user",
  "limit",
  "cursor",
  "orderBy",
  "createdAt",
  "updatedAt",
  "includeArchived",
];
const STATUS_CONTINUATION_FLAGS = [
  ...STATUS_LIST_FIELDS.filter((name) => name !== "cursor"),
  "full",
];

export async function statusCommand(args: string[], runtime: Runtime) {
  return dispatchCommandGroup(args, {
    name: "statuses",
    help: () => groupHelp("statuses", ["list"]),
    handlers: {
      list: (rest) => listStatusesCommand(rest, runtime),
    },
    unknownHelp: ["Run `linear-axi statuses list --team <team>`"],
  });
}

async function listStatusesCommand(args: string[], runtime: Runtime) {
  const parsed = parseFlags(args, {
    boolean: ["help", "full", "includeArchived"],
    example: "statuses list --team ENG",
  });
  if (parsed.help) return statusListHelp();
  const team = requireTeam(parsed, ["Run `linear-axi statuses list --team <team>`"]);
  const result = await callAvailableTool(
    runtime,
    ["list_issue_statuses"],
    collectKnownArgs(parsed, STATUS_LIST_FIELDS),
  );
  const data = extractData(result);
  const rows = parsed.full ? data : compactRows("statuses", data);
  const rowCount = asArray(data).length;
  const page = paginationInfo(data, rowCount);
  const statusesValue =
    Array.isArray(rows) && rows.length === 0 ? `0 statuses found for ${team}` : rows;
  const help = [
    `Run \`linear-axi statuses list --team ${formatCommandArg(team)} --full\` to show the full response`,
  ];
  appendContinuationHelp(
    help,
    "linear-axi statuses list",
    parsed,
    STATUS_CONTINUATION_FLAGS,
    page.cursor,
  );
  return renderToon({
    count: page.count,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    statuses: statusesValue,
    help,
  });
}

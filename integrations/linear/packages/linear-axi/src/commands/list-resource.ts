import type { Runtime } from "#axi/types.ts";
import { optionalText } from "./command-input.ts";
import { parseFlags, usage } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import {
  appendContinuationHelp,
  collectKnownArgs,
  dispatchCommandGroup,
} from "#axi/lib/cli-helpers.ts";
import {
  compactRows,
  fieldHint,
  paginationInfo,
  parseFields,
  selectFields,
} from "#axi/lib/linear-format.ts";
import { asArray, callAvailableTool, extractData } from "#axi/lib/mcp-tools.ts";
import { applyRepoProjectDefault } from "#axi/lib/repo-project.ts";
import { groupHelp, listAliasHelp } from "./help.ts";
import { viewResourceCommand } from "./resource-view.ts";
import {
  DEFAULT_LIMIT,
  LIST_BOOLEAN_FLAGS,
  LIST_TOOL_ARG_FLAGS,
  LIST_CONTINUATION_FLAGS,
  LIST_TOOL_ALIASES,
  PROJECT_SCOPED_LIST_ALIASES,
  pluralName,
} from "./shared.ts";

const EMPTY_LIST_HINTS: Record<string, readonly string[] | undefined> = {
  issues: [
    'Run `linear-axi issues create --title "..." --team "<team>"` to create an issue',
    "Run `linear-axi issues list --state done` to see done issues",
  ],
  projects: ['Run `linear-axi projects create --name "..." --team "<team>"` to create a project'],
  documents: [
    'Run `linear-axi documents create --title "..." --team "<team>" --content-file <path>` to create a document',
  ],
};

export async function listResourceCommand(alias: string, args: string[], runtime: Runtime) {
  const publicName = pluralName(alias);
  return dispatchCommandGroup(args, {
    name: publicName,
    help: () => groupHelp(publicName, publicName === "teams" ? ["list", "view"] : ["list"]),
    handlers: {
      list: (rest) => aliasListCommand(alias, rest, runtime),
      ...(publicName === "teams"
        ? { view: (rest) => viewResourceCommand("team", rest, runtime) }
        : {}),
    },
    unknownHelp: [`Run \`linear-axi ${publicName} list\``],
  });
}

export async function aliasListCommand(alias: string, args: string[], runtime: Runtime) {
  const publicName = pluralName(alias);
  const toolNames = LIST_TOOL_ALIASES[alias];
  if (!toolNames) throw usage(`unknown resource: ${alias}`);
  const parsed = parseFlags(args, {
    boolean: ["help", ...LIST_BOOLEAN_FLAGS],
    example: `${publicName} list --limit ${DEFAULT_LIMIT}`,
  });
  if (parsed.help) return listAliasHelp(publicName);
  if (parsed["all-projects"] && !PROJECT_SCOPED_LIST_ALIASES.includes(alias)) {
    throw usage("--all-projects is only supported for issues and documents", [
      "Run `linear-axi issues list --all-projects`",
      "Run `linear-axi documents list --all-projects`",
    ]);
  }
  const toolArgs = collectKnownArgs(parsed, LIST_TOOL_ARG_FLAGS);
  if (!("limit" in toolArgs)) toolArgs.limit = DEFAULT_LIMIT;
  if (PROJECT_SCOPED_LIST_ALIASES.includes(alias)) {
    await applyRepoProjectDefault(toolArgs, runtime, {
      allProjects: Boolean(parsed["all-projects"]),
      allProjectsCommand: `linear-axi ${publicName} list --all-projects`,
      command: `linear-axi ${publicName} list`,
      requireProject: true,
    });
  }

  if (alias === "documents") {
    for (const field of ["project", "team"]) {
      if (toolArgs[field] !== undefined) {
        toolArgs[`${field}Id`] = toolArgs[field];
        delete toolArgs[field];
      }
    }
  }
  const result = await callAvailableTool(runtime, toolNames, toolArgs);
  const data = extractData(result);
  const dataRows = asArray(data);
  const fields = optionalText(parsed.fields);
  const rows = parsed.full
    ? data
    : fields
      ? selectFields(dataRows, parseFields(fields))
      : compactRows(alias, data);
  const rowCount = dataRows.length;
  const page = paginationInfo(data, rowCount);
  const help = listHints(publicName, rowCount);
  appendContinuationHelp(
    help,
    `linear-axi ${publicName} list`,
    parsed,
    LIST_CONTINUATION_FLAGS,
    page.cursor,
  );
  return renderToon({
    count: page.count,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    [publicName]: rows,
    help,
  });
}

function listHints(publicName: string, rowCount: number) {
  if (rowCount > 0)
    return [
      `Run \`linear-axi ${publicName} list --fields ${fieldHint(publicName)}\` to choose fields`,
    ];
  const hints = EMPTY_LIST_HINTS[publicName] ?? [
    `Run \`linear-axi ${publicName} list --query "<text>"\` to search ${publicName}`,
  ];
  return [...hints];
}

import type { InputRecord, ParsedFlags, Runtime } from "#axi/types.ts";
import { requireText } from "./command-input.ts";
import { parseFlags, usage } from "#axi/args.ts";
import {
  applyTextFileFlag,
  collectKnownArgs,
  dispatchCommandGroup,
  rejectIdOnCreate,
} from "#axi/lib/cli-helpers.ts";
import { compactIssueDetail, compactIssueMutation } from "#axi/lib/linear-format.ts";
import { applyRepoProjectDefault } from "#axi/lib/repo-project.ts";
import { groupHelp, issueCreateHelp, issueUpdateHelp, issueViewHelp } from "./help.ts";
import { aliasListCommand } from "./list-resource.ts";
import {
  ensureIssueDoesNotExist,
  ensureIssueExists,
  renderDetailView,
  renderMutation,
} from "./shared.ts";

const ISSUE_MUTATION_FIELDS = [
  "id",
  "title",
  "team",
  "description",
  "state",
  "assignee",
  "project",
  "cycle",
  "parentId",
  "dueDate",
  "estimate",
  "priority",
];
const ISSUE_CREATE_HELP = [
  'Run `linear-axi issues create --title "Title" --team "<team>"`',
  'Run `linear-axi issues list --team "<team>" --query "Title"` to check existing issues',
];
const ISSUE_UPDATE_HELP = [
  'Run `linear-axi issues update --id LIN-123 --state "Done"`',
  "Run `linear-axi issues list --query <text>` to find the issue id",
];
const ISSUE_ID_ON_CREATE_HELP = [
  'Run `linear-axi issues create --title "Title" --team "<team>"` to create a new issue',
  'Run `linear-axi issues update --id LIN-123 --state "Done"` to edit an existing issue',
];

export async function issueCommand(args: string[], runtime: Runtime) {
  return dispatchCommandGroup(args, {
    name: "issues",
    help: () => groupHelp("issues", ["list", "view", "create", "update"]),
    handlers: {
      list: (rest) => aliasListCommand("issues", rest, runtime),
      view: (rest) => viewIssueCommand(rest, runtime),
      create: (rest) => createIssueCommand(rest, runtime),
      update: (rest) => updateIssueCommand(rest, runtime),
    },
    unknownHelp: [
      "Run `linear-axi issues list`",
      "Run `linear-axi issues view <id>`",
      "Run `linear-axi issues update --id <id> --state done`",
    ],
  });
}

async function viewIssueCommand(args: string[], runtime: Runtime) {
  const parsed = parseFlags(args, { boolean: ["help", "full"], example: "issues view LIN-123" });
  if (parsed.help) return issueViewHelp();
  const id = parsed.positionals[0];
  if (!id) throw usage("issue id is required", ["Run `linear-axi issues view <id>`"]);
  if (id === "all")
    throw usage("issues view expects one issue id", [
      "Run `linear-axi issues list --limit 50` to view many issues",
      "Run `linear-axi issues view <id>` to view one issue",
    ]);
  const detail = await ensureIssueExists(id, runtime);
  return renderDetailView({
    resource: "issue",
    detail,
    full: Boolean(parsed.full),
    compact: compactIssueDetail,
    fullCommand: `linear-axi issues view ${id} --full`,
  });
}

async function createIssueCommand(args: string[], runtime: Runtime) {
  const parsed = parseFlags(args, {
    boolean: ["help"],
    array: ["label"],
    example: 'issues create --title "Bug" --team ENG',
  });
  if (parsed.help) return issueCreateHelp();
  rejectIdOnCreate("issue", ISSUE_ID_ON_CREATE_HELP, parsed);
  const toolArgs = await issueToolArgs(parsed, runtime);
  await applyRepoProjectDefault(toolArgs, runtime, {
    command: "linear-axi issues create",
    requireProject: true,
  });
  const message = "creating an issue requires --title and --team";
  const title = requireText(toolArgs.title, message, ISSUE_CREATE_HELP);
  const team = requireText(toolArgs.team, message, ISSUE_CREATE_HELP);
  await ensureIssueDoesNotExist(title, team, runtime);
  return saveIssue(toolArgs, runtime, [
    'Run `linear-axi issues create --title "Title" --team "<team>"`',
    "Run `linear-axi projects list --full` to confirm project/team compatibility",
  ]);
}

async function updateIssueCommand(args: string[], runtime: Runtime) {
  const parsed = parseFlags(args, {
    boolean: ["help"],
    array: ["label"],
    example: "issues update --id LIN-123 --state Done",
  });
  if (parsed.help) return issueUpdateHelp();
  const toolArgs = await issueToolArgs(parsed, runtime);
  if (!toolArgs.id) await applyRepoProjectDefault(toolArgs, runtime);
  const id = requireText(toolArgs.id, "updating an issue requires --id", ISSUE_UPDATE_HELP);
  await ensureIssueExists(id, runtime);
  return saveIssue(toolArgs, runtime, ISSUE_UPDATE_HELP);
}

async function issueToolArgs(parsed: ParsedFlags, runtime: Runtime) {
  const toolArgs = collectKnownArgs(parsed, ISSUE_MUTATION_FIELDS);
  if (parsed.label) toolArgs.labels = parsed.label;
  await applyTextFileFlag(toolArgs, parsed, {
    flag: "description-file",
    field: "description",
    cwd: runtime.cwd,
  });
  return toolArgs;
}

async function saveIssue(toolArgs: InputRecord, runtime: Runtime, help: string[]) {
  return renderMutation(runtime, {
    tool: "save_issue",
    args: toolArgs,
    help,
    render: (issue) => ({ issue: compactIssueMutation(issue) }),
  });
}

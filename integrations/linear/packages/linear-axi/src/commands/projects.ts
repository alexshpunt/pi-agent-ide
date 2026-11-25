import type { InputRecord, Runtime } from "#axi/types.ts";
import { requireText } from "./command-input.ts";
import { parseFlags } from "#axi/args.ts";
import {
  applyTextFileFlag,
  collectKnownArgs,
  dispatchCommandGroup,
  rejectIdOnCreate,
} from "#axi/lib/cli-helpers.ts";
import { compactProjectMutation } from "#axi/lib/linear-format.ts";
import { groupHelp, projectCreateHelp, projectUpdateHelp } from "./help.ts";
import { aliasListCommand } from "./list-resource.ts";
import { viewResourceCommand } from "./resource-view.ts";
import {
  ensureProjectDoesNotExist,
  ensureProjectExists,
  projectSaveToolArgs,
  renderMutation,
} from "./shared.ts";

const PROJECT_MUTATION_FIELDS = [
  "id",
  "name",
  "team",
  "teamId",
  "summary",
  "description",
  "state",
  "status",
  "lead",
  "startDate",
  "targetDate",
];
const PROJECT_CREATE_HELP = [
  'Run `linear-axi projects create --name "Roadmap" --team "<team>"`',
  "Run `linear-axi teams list --fields id,name,key` to choose a team",
];
const PROJECT_UPDATE_HELP = [
  'Run `linear-axi projects update --id <id> --summary "Updated scope"`',
  'Run `linear-axi projects list --query "Roadmap" --fields id,name,status` to find the project id',
];
const PROJECT_ID_ON_CREATE_HELP = [
  'Run `linear-axi projects create --name "Roadmap" --team "<team>"`',
  'Run `linear-axi projects update --id <id> --summary "Updated scope"` to edit an existing project',
];

export async function projectCommand(args: string[], runtime: Runtime) {
  return dispatchCommandGroup(args, {
    name: "projects",
    help: () => groupHelp("projects", ["list", "view", "create", "update"]),
    handlers: {
      list: (rest) => aliasListCommand("projects", rest, runtime),
      view: (rest) => viewResourceCommand("project", rest, runtime),
      create: (rest) => createProjectCommand(rest, runtime),
      update: (rest) => updateProjectCommand(rest, runtime),
    },
    unknownHelp: [
      "Run `linear-axi projects list`",
      'Run `linear-axi projects create --name "Roadmap" --team "<team>"`',
    ],
  });
}

async function createProjectCommand(args: string[], runtime: Runtime) {
  const parsed = parseFlags(args, {
    boolean: ["help"],
    example: 'projects create --name "Roadmap" --team ENG',
  });
  if (parsed.help) return projectCreateHelp();
  rejectIdOnCreate("project", PROJECT_ID_ON_CREATE_HELP, parsed);
  const toolArgs = collectKnownArgs(parsed, PROJECT_MUTATION_FIELDS);
  const message = "creating a project requires --name and --team";
  const name = requireText(toolArgs.name, message, PROJECT_CREATE_HELP);
  const team = requireText(toolArgs.team ?? toolArgs.teamId, message, PROJECT_CREATE_HELP);
  await ensureProjectDoesNotExist(name, team, runtime);
  return saveProject(toolArgs, runtime, ["create_project", "save_project"]);
}

async function updateProjectCommand(args: string[], runtime: Runtime) {
  const parsed = parseFlags(args, {
    boolean: ["help"],
    example: 'projects update --id <id> --summary "Updated scope"',
  });
  if (parsed.help) return projectUpdateHelp();
  const toolArgs = collectKnownArgs(parsed, PROJECT_MUTATION_FIELDS);
  const id = requireText(toolArgs.id, "updating a project requires --id", PROJECT_UPDATE_HELP);
  await applyTextFileFlag(toolArgs, parsed, {
    flag: "description-file",
    field: "description",
    cwd: runtime.cwd,
  });
  await ensureProjectExists(id, runtime);
  return saveProject(toolArgs, runtime, ["update_project", "save_project"]);
}

async function saveProject(toolArgs: InputRecord, runtime: Runtime, toolNames: readonly string[]) {
  return renderMutation(runtime, {
    toolNames,
    args: (toolName) => projectSaveToolArgs(toolName, toolArgs),
    help: PROJECT_CREATE_HELP,
    render: (project) => ({ project: compactProjectMutation(project) }),
  });
}

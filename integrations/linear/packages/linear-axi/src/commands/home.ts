import { collapseHome } from "#axi/config.ts";
import { formatCommandArg } from "#axi/lib/cli-helpers.ts";
import { paginationInfo } from "#axi/lib/linear-format.ts";
import { asArray, callAvailableTool, extractData } from "#axi/lib/mcp-tools.ts";
import {
  extractWorkspaceName,
  readRepoProject,
  validateRepoProject,
} from "#axi/lib/repo-project.ts";
import { mcpErrorMessage, workspaceName } from "./shared.ts";
import type { InputRecord, Runtime } from "#axi/types.ts";

export async function homeCommand(runtime: Runtime) {
  let issueCount = 0;
  let issueMore = false;
  let error: string | undefined;
  const repoProject = await readRepoProject(runtime.cwd);

  const output: InputRecord = {
    bin: collapseHome(runtime.binPath ?? "linear-axi"),
    description: "Linear project dashboard",
    workspace: await linearWorkspaceName(runtime),
  };

  if (!repoProject) {
    output.project = "not initialized";
    output.repo = await workspaceName(runtime.cwd);
    output.status = "No default Linear project is configured for this repository";
    output.help = [
      "Run `linear-axi projects list` to find Linear projects",
      'Run `linear-axi init --project "<project>"` to bind this repo',
      "Run `linear-axi issues list --assignee me --all-projects` to list your assigned issues across Linear",
      "Run `linear-axi <command> <subcommand>` — commands: auth, issues, projects, teams, users, comments, documents",
    ];
    return output;
  }

  try {
    const validatedProject = await validateRepoProject(repoProject, runtime);
    const result = await runtime.client.callTool("list_issues", {
      assignee: "me",
      limit: 10,
      orderBy: "updatedAt",
      project: validatedProject.project,
    });
    const data = extractData(result);
    issueCount = asArray(data).length;
    issueMore = Boolean(paginationInfo(data, issueCount).cursor);
  } catch (caught) {
    error = mcpErrorMessage(caught);
  }

  output.project = repoProject.project;
  output.repo = await workspaceName(runtime.cwd);

  if (isInvalidRepoProject(error)) {
    output.status = "Default Linear project is invalid";
    output.error = error;
    output.help = [
      `Run \`linear-axi projects list --query ${formatCommandArg(repoProject.project)} --fields id,name,status\` to search the current workspace`,
      'Run `linear-axi init --project "<project>" --force` to update .linear-project',
    ];
    return output;
  }

  if (error) {
    output.status = "Linear MCP connection unavailable";
    output.error = error;
  } else {
    output.issues = `${issueCount}${issueMore ? "+" : ""} assigned to me in project`;
  }

  output.help = [
    "Run `linear-axi <command> <subcommand>` — commands: auth, issues, projects, teams, users, comments, documents",
  ];

  return output;
}

async function linearWorkspaceName(runtime: Runtime) {
  try {
    const result = await callAvailableTool(
      runtime,
      ["get_organization", "get_workspace", "list_projects", "list_teams"],
      (toolName) => (["list_projects", "list_teams"].includes(toolName) ? { limit: 1 } : {}),
    );
    return extractWorkspaceName(extractData(result)) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function isInvalidRepoProject(error: string | undefined) {
  return (
    typeof error === "string" && error.startsWith("The saved default Linear project does not exist")
  );
}

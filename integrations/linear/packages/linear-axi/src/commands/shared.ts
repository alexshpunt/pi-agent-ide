import { mcpToolFailure } from "#axi/lib/mcp-error.ts";
import { basename, resolve } from "node:path";
import { AxiError, usage } from "#axi/args.ts";
import { renderToon } from "#axi/format.ts";
import { formatCommandArg, TOOL_BOOLEAN_FLAGS } from "#axi/lib/cli-helpers.ts";
import { sanitizeDocument } from "#axi/lib/linear-format.ts";
import {
  asArray,
  callAvailableTool,
  extractData,
  hasTool,
  isUnknownToolError,
  mutationData,
} from "#axi/lib/mcp-tools.ts";
import { projectMatches } from "#axi/lib/project-match.ts";
import { findGitRoot } from "#axi/lib/repo-project.ts";
import { valueText } from "#axi/lib/value-text.ts";
import {
  asRecord,
  isRecord,
  isUnknownArray,
  type InputRecord,
  type ParsedFlags,
  type Runtime,
} from "#axi/types.ts";
import { resourceOperationFailure, type ResourceFailureReason } from "#axi/lib/resource-failure.ts";

export const DEFAULT_LIMIT = 50;
const TRANSPORT_REASONS = new Set<ResourceFailureReason>([
  "CONNECT_FAILED",
  "CONNECTION_FAILED",
  "TIMEOUT",
]);

export const LIST_TOOL_ALIASES: Record<string, readonly string[] | undefined> = {
  issues: ["list_issues"],
  issue: ["list_issues"],
  projects: ["list_projects"],
  project: ["list_projects"],
  teams: ["list_teams"],
  team: ["list_teams"],
  users: ["list_users"],
  user: ["list_users"],
  documents: ["list_documents"],
  document: ["list_documents"],
  labels: ["list_issue_labels"],
  label: ["list_issue_labels"],
};

export const PROJECT_SCOPED_LIST_ALIASES = ["issues", "documents"];

export const LIST_BOOLEAN_FLAGS = ["full", "all-projects", ...TOOL_BOOLEAN_FLAGS];

export const LIST_TOOL_ARG_FLAGS = [
  "assignee",
  "createdAt",
  "cursor",
  "cycle",
  "delegate",
  "label",
  "limit",
  "member",
  "name",
  "orderBy",
  "parentId",
  "priority",
  "project",
  "query",
  "state",
  "team",
  "teamId",
  "updatedAt",
  ...TOOL_BOOLEAN_FLAGS,
];

export const LIST_CONTINUATION_FLAGS = [
  ...LIST_TOOL_ARG_FLAGS.filter((name) => name !== "cursor"),
  "fields",
  "full",
  "all-projects",
];

export async function getIssueDetail(id: string, runtime: Runtime) {
  return getDetailWithListFallback(runtime, {
    detailTool: "get_issue",
    detailArgs: { id },
    listTool: "list_issues",
    listArgs: { query: id, limit: 10 },
    identityFields: ["identifier", "id", "title"],
    matches: (issue) => issue.id === id || issue.identifier === id,
  });
}

export async function ensureIssueExists(id: string, runtime: Runtime) {
  return requireExistingDetail(getIssueDetail(id, runtime), "issue", id, [
    `Run \`linear-axi issues list --query ${formatCommandArg(id)}\` to search for the issue`,
    'Run `linear-axi issues create --title "Title" --team "<team>"` to create a new issue',
  ]);
}

export async function ensureIssueDoesNotExist(title: string, team: string, runtime: Runtime) {
  await ensureNamedResourceDoesNotExist(runtime, {
    resource: "issue",
    listTool: "list_issues",
    listArgs: { query: title, team, limit: 10 },
    query: title,
    team,
    name: (issue) => issue.title,
    id: (issue) => valueText(issue.identifier ?? issue.id ?? "<id>"),
    help: (id) => [
      `Run \`linear-axi issues view ${id}\` to inspect the existing issue`,
      `Run \`linear-axi issues update --id ${id} --state "<state>"\` to edit it`,
      `Run \`linear-axi issues create --title ${formatCommandArg(`${title} copy`)} --team ${formatCommandArg(team)}\` to create a distinct issue`,
    ],
  });
}

export async function getProjectDetail(id: string, runtime: Runtime) {
  return getDetailWithListFallback(runtime, {
    detailTool: "get_project",
    detailArgs: { query: id },
    listTool: "list_projects",
    listArgs: { query: id, limit: 10 },
    identityFields: ["id", "slugId", "name"],
    requireKnownDetailTool: true,
    fallbackOnBlankDetail: true,
    detailMatches: (project) => projectMatches(project, id),
    matches: (project) => projectMatches(project, id),
  });
}

export async function ensureProjectExists(id: string, runtime: Runtime) {
  return requireExistingDetail(getProjectDetail(id, runtime), "project", id, [
    `Run \`linear-axi projects list --query ${formatCommandArg(id)} --fields id,name,status\` to search for the project`,
    'Run `linear-axi projects create --name "Roadmap" --team "<team>"` to create a new project',
  ]);
}

export async function ensureProjectDoesNotExist(name: string, team: string, runtime: Runtime) {
  await ensureNamedResourceDoesNotExist(runtime, {
    resource: "project",
    listTool: "list_projects",
    listArgs: { query: name, limit: 10 },
    query: name,
    team,
    name: (project) => project.name,
    id: (project) => valueText(project.id ?? project.slugId ?? "<id>"),
    help: (id) => [
      `Run \`linear-axi projects list --query ${formatCommandArg(name)} --full\` to inspect matching projects`,
      `Run \`linear-axi projects update --id ${id} --summary "Updated scope"\` to edit it`,
      `Run \`linear-axi projects create --name ${formatCommandArg(`${name} copy`)} --team ${formatCommandArg(team)}\` to create a distinct project`,
    ],
  });
}

export function projectSaveToolArgs(toolName: string, args: InputRecord): InputRecord {
  if (toolName !== "save_project") return args;
  const { team, teamId, ...projectArgs } = args;
  const teamRef = teamId ?? team;
  if (teamRef === undefined) return projectArgs;
  return {
    ...projectArgs,
    [projectArgs.id ? "addTeams" : "setTeams"]: [teamRef],
  };
}

type MutationArgs =
  | { tool: string; args: InputRecord }
  | { toolNames: readonly string[]; args: InputRecord | ((tool: string) => InputRecord) };

type MutationOptions = MutationArgs & {
  help: string[];
  render: (value: unknown) => InputRecord;
};

export async function renderMutation(runtime: Runtime, options: MutationOptions): Promise<string> {
  const result =
    "toolNames" in options
      ? await callAvailableTool(runtime, options.toolNames, options.args)
      : await runtime.client.callTool(options.tool, options.args);
  if (result.isError) throw mcpToolFailure("OPERATION", result);
  return renderToon(options.render(mutationData(result, options.help)));
}

interface DetailViewOptions<Resource extends string> {
  resource: Resource;
  detail: unknown;
  full: boolean;
  compact: (detail: unknown) => { truncated: boolean } & Record<Resource, unknown>;
  fullCommand: string;
}

export function renderDetailView<Resource extends string>(
  options: DetailViewOptions<Resource>,
): string {
  if (options.full) return renderToon({ [options.resource]: options.detail });
  const compact = options.compact(options.detail);
  return renderToon({
    [options.resource]: compact[options.resource],
    ...(compact.truncated
      ? { help: [`Run \`${options.fullCommand}\` to show the complete ${options.resource}`] }
      : {}),
  });
}

export async function getDocumentDetail(id: string, runtime: Runtime) {
  return getDetailWithListFallback(runtime, {
    detailTool: "get_document",
    detailArgs: { id },
    listTool: "list_documents",
    listArgs: { query: id, limit: 10 },
    identityFields: ["id", "title", "name"],
    matches: (document) => document.id === id || document.slugId === id,
    transform: (document) => sanitizeDocument(document, id),
  });
}

interface DetailOptions {
  detailTool: string;
  detailArgs: InputRecord;
  listTool: string;
  listArgs: InputRecord;
  identityFields: readonly string[];
  requireKnownDetailTool?: boolean;
  fallbackOnBlankDetail?: boolean;
  detailMatches?: (value: unknown) => boolean;
  matches: (item: InputRecord) => boolean;
  transform?: (value: unknown) => unknown;
}

async function getDetailWithListFallback(
  runtime: Runtime,
  options: DetailOptions,
): Promise<unknown> {
  const knownToolNames = options.requireKnownDetailTool
    ? new Set(
        (typeof runtime.client.listTools === "function"
          ? await runtime.client.listTools()
          : []
        ).map((tool) => tool.name),
      )
    : null;
  const hasListTool = () =>
    knownToolNames ? knownToolNames.has(options.listTool) : hasTool(runtime, options.listTool);

  if (!options.requireKnownDetailTool || knownToolNames?.has(options.detailTool)) {
    try {
      const detailed = options.requireKnownDetailTool
        ? await runtime.client.callTool(options.detailTool, options.detailArgs)
        : await callAvailableTool(runtime, [options.detailTool], options.detailArgs);
      const data = extractData(detailed);
      if (isBlankDetail(data, options.identityFields)) {
        if (!options.fallbackOnBlankDetail || !(await hasListTool())) return null;
      } else if (options.detailMatches && !options.detailMatches(data)) {
        if (!(await hasListTool())) return null;
      } else {
        return detailResult(data, options);
      }
    } catch (error) {
      if (!isUnknownToolError(error)) throw error;
    }
  }

  const listed = await runtime.client.callTool(options.listTool, options.listArgs);
  const match = asArray(extractData(listed)).find(options.matches);
  if (!match) return null;
  return detailResult(match, options);
}

function detailResult(detail: unknown, options: DetailOptions): unknown {
  return options.transform ? options.transform(detail) : detail;
}

interface NamedResourceOptions {
  resource: string;
  listTool: string;
  listArgs: InputRecord;
  query: string;
  team: string;
  name: (item: InputRecord) => unknown;
  id: (item: InputRecord) => string;
  help: (id: string) => string[];
}

async function ensureNamedResourceDoesNotExist(
  runtime: Runtime,
  options: NamedResourceOptions,
): Promise<void> {
  const listed = await runtime.client.callTool(options.listTool, options.listArgs);
  const match = asArray(extractData(listed)).find((item) => {
    return isSameText(options.name(item), options.query) && belongsToTeam(item, options.team);
  });
  if (!match) return;
  const id = options.id(match);
  const name = valueText(options.name(match) ?? options.query);
  throw new AxiError(
    "operational",
    `${options.resource} already exists: ${id} ${name}`,
    options.help(id),
  );
}

export async function ensureDocumentExists(id: string, runtime: Runtime) {
  return requireExistingDetail(getDocumentDetail(id, runtime), "document", id, [
    `Run \`linear-axi documents list --query ${formatCommandArg(id)} --fields id,title,updatedAt\` to search for the document`,
    'Run `linear-axi documents create --title "Spec" --team "<team>"` to create a new document',
  ]);
}

async function requireExistingDetail(
  detailPromise: Promise<unknown>,
  resource: string,
  id: string,
  help: string[],
): Promise<unknown> {
  const detail = await detailPromise;
  if (!detail) throw notFound(resource, id, help);
  return detail;
}

export async function ensureMilestoneExists(
  project: string,
  id: string,
  runtime: Runtime,
): Promise<unknown> {
  const result = await runtime.client.callTool("get_milestone", { project, query: id });
  const milestone = extractData(result);
  if (!milestone || isEmptyContainer(milestone)) {
    throw notFound("milestone", id, [
      `Run \`linear-axi milestones list --project ${formatCommandArg(project)}\` to find the milestone id`,
      `Run \`linear-axi milestones create --project ${formatCommandArg(project)} --name "<name>"\` to create a new milestone`,
    ]);
  }
  return milestone;
}

export function rejectUnsupportedCommentFlags(parsed: ParsedFlags) {
  const unsupported = [
    "issueId",
    "project",
    "projectId",
    "initiative",
    "initiativeId",
    "document",
    "documentId",
    "milestone",
    "milestoneId",
    "parentId",
  ].find((name) => parsed[name] !== undefined);
  if (unsupported) {
    throw usage(`--${unsupported} is not supported for comments`, [
      "Run `linear-axi comments list --issue LIN-123`",
      'Run `linear-axi comments create --issue LIN-123 --body "Ready"`',
    ]);
  }
}

export function normalizeError(error: unknown) {
  if (error instanceof AxiError) return error;
  if (hasAuthorizationUrl(error)) {
    return new AxiError("operational", "Linear MCP OAuth authorization required", [
      "Run `linear-axi auth login`",
      "Open the authorization URL and finish with `linear-axi auth finish --code <code>`",
    ]);
  }
  // A transport cause gets a closed code such as LINEAR_OPERATION_CONNECT_FAILED instead of
  // raw exception text like "fetch failed". Other causes keep their established messages.
  // The effect stays with the caller, which knows whether a mutation was dispatched.
  const failure = resourceOperationFailure("OPERATION", error);
  if (TRANSPORT_REASONS.has(failure.reason)) return failure;
  return new AxiError("operational", mcpErrorMessage(error), [
    "Run `linear-axi issues list --assignee me` to verify Linear access",
    "Run `linear-axi auth login` to authorize the default Linear MCP endpoint",
  ]);
}

export function notFound(resource: string, id: string, help: string[] = []) {
  return new AxiError("not_found", `${resource} not found: ${id}`, help);
}

export function mcpErrorMessage(error: unknown): string {
  if (hasAuthorizationUrl(error)) {
    return "Linear MCP OAuth authorization required";
  }
  const record = asRecord(error);
  const message = typeof record?.message === "string" ? record.message : valueText(error);
  if (/unauthorized|401|invalid_token|access token/i.test(message)) {
    return "Linear MCP authentication failed";
  }
  return message;
}

export async function workspaceName(cwd: string) {
  const root = await findGitRoot(cwd);
  return basename(root ?? resolve(cwd));
}

export function pluralName(name: string): string {
  const names: Record<string, string | undefined> = {
    issue: "issues",
    project: "projects",
    team: "teams",
    user: "users",
    document: "documents",
    label: "labels",
  };
  return names[name] ?? name;
}

function isSameText(left: unknown, right: unknown) {
  return (
    valueText(left ?? "")
      .trim()
      .toLocaleLowerCase() ===
    valueText(right ?? "")
      .trim()
      .toLocaleLowerCase()
  );
}

function isEmptyContainer(value: unknown) {
  return value !== null && typeof value === "object" && Object.keys(value).length === 0;
}

function isBlankDetail(value: unknown, identityFields: readonly string[]) {
  if (!isRecord(value)) return false;
  return identityFields.every((field) => !hasText(value[field]));
}

function hasText(value: unknown) {
  return valueText(value ?? "").trim() !== "";
}

function belongsToTeam(item: InputRecord, team: string) {
  if (!team) return true;
  const groupKeys = (value: unknown): unknown[] => {
    const group = asRecord(value);
    return [value, group?.id, group?.key, group?.name];
  };
  const candidates = [
    ...groupKeys(item.team),
    item.teamId,
    ...(isUnknownArray(item.teams) ? item.teams.flatMap(groupKeys) : []),
  ];
  return candidates.some((candidate) => isSameText(candidate, team));
}

function hasAuthorizationUrl(error: unknown): boolean {
  return Boolean(asRecord(error)?.authorizationUrl);
}

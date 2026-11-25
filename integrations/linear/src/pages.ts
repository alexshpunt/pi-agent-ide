import { decode } from "@toon-format/toon-v4";
import { decodeAxiObject, runAxi } from "./axi.ts";
import { attachmentReadUrl } from "./asset-address.ts";
import type { PageReader } from "./read.ts";
import {
  isDocumentId,
  parseDocumentUrl,
  parseIssueUrl,
  parsePageUrl,
  type PageUrl,
} from "./urls.ts";

type Row = Record<string, unknown>;
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LINEAR_INVALID_RESPONSE");
  return value as Row;
}
function string(row: Row, key: string): string {
  if (typeof row[key] !== "string" || !row[key]) throw new Error("LINEAR_INVALID_RESPONSE");
  return row[key];
}
function label(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\r\n]+/gu, " ") : "";
}
function status(row: Row): string {
  return label(typeof row.status === "object" && row.status ? object(row.status).name : row.status);
}
function mismatch(): never {
  throw new Error("LINEAR_IDENTITY_MISMATCH");
}

function projectIdentity(row: Row, page: PageUrl): string {
  const url = string(row, "url");
  const reference = parsePageUrl(url);
  if (
    !reference ||
    reference.kind !== "project" ||
    reference.workspace !== page.workspace ||
    (page.kind === "project" &&
      reference.identifier !== page.identifier &&
      row.uuid !== page.identifier)
  )
    mismatch();
  return reference.source;
}
function checkIssue(row: Row, page: PageUrl, team: Row): void {
  const reference = parseIssueUrl(string(row, "url"));
  if (
    !reference ||
    reference.workspace !== page.workspace ||
    reference.identifier !== row.id ||
    row.teamId !== team.id
  )
    mismatch();
  string(row, "title");
}
function checkProject(row: Row, page: PageUrl, team: Row): void {
  projectIdentity(row, page);
  string(row, "name");
  let teams: unknown = row.teams;
  if (typeof teams === "string") {
    try {
      teams = JSON.parse(teams);
    } catch {
      throw new Error("LINEAR_INVALID_RESPONSE");
    }
  }
  if (!Array.isArray(teams) || !teams.some((item) => object(item).id === team.id)) mismatch();
}
function list(output: string, key: string): { rows: Row[]; cursor?: string } {
  let data: Row;
  try {
    // CLI help uses human-readable list indentation, not TOON list items.
    // Decode only the data table and its pagination metadata, still strictly.
    const selected = output
      .split(/\n(?=\S)/u)
      .filter(
        (chunk) =>
          chunk.startsWith("count:") ||
          chunk.startsWith("cursor:") ||
          chunk.startsWith(`${key}[`) ||
          chunk.startsWith(`${key}:`),
      )
      .join("\n");
    data = object(decode(selected));
  } catch {
    throw new Error("LINEAR_INVALID_RESPONSE");
  }
  if (!Array.isArray(data[key])) throw new Error("LINEAR_INVALID_RESPONSE");
  const rows = (data[key] as unknown[]).map(object);
  if (rows.length > 50) throw new Error("LINEAR_INVALID_RESPONSE");
  const cursor = data.cursor;
  if (
    cursor !== undefined &&
    cursor !== null &&
    (typeof cursor !== "string" || !cursor || cursor.length > 1024 || /[\r\n]/u.test(cursor))
  )
    throw new Error("LINEAR_INVALID_RESPONSE");
  // Never describe a partial backend response as the end of a list.
  if (typeof data.count === "string" && /more available/iu.test(data.count) && !cursor)
    throw new Error("LINEAR_INVALID_RESPONSE");
  return { rows, ...(typeof cursor === "string" ? { cursor } : {}) };
}

/** Create a bounded read-only AXI page adapter; the runner is injectable for contract tests. */
export function createAxiPageReader(run: typeof runAxi = runAxi): PageReader {
  return async (source, cwd, signal, capture) => {
    const page = parsePageUrl(source);
    if (!page) throw new Error("LINEAR_INVALID_URL");
    if (page.kind === "project") {
      const project = object(
        decodeAxiObject(
          await run(cwd, ["projects", "view", page.identifier, "--full"], signal),
          "project",
          ["id", "uuid", "name", "url", "description", "status", "resources", "resourceCount"],
        ).project,
      );
      const url = projectIdentity(project, page);
      // AXI omits the resources field when the project has none.
      const resources =
        project.resources === undefined && project.resourceCount === 0 ? [] : project.resources;
      if (resources !== undefined && !Array.isArray(resources))
        throw new Error("LINEAR_INVALID_RESPONSE");
      if (
        typeof project.resourceCount === "number" &&
        project.resourceCount !== (resources as unknown[] | undefined)?.length
      )
        throw new Error("LINEAR_INVALID_RESPONSE");
      const links = (resources as unknown[] | undefined)?.map((item) => {
        const row = object(item);
        const link = new URL(string(row, "url"));
        if (link.protocol !== "https:" || link.username || link.password)
          throw new Error("LINEAR_INVALID_RESPONSE");
        if (link.hostname === "linear.app") {
          const document = parseDocumentUrl(link.href);
          if (document && document.workspace !== page.workspace) mismatch();
        }
        return `- ${label(string(row, "title"))}: <${attachmentReadUrl(page.workspace, link.href)}>`;
      });
      if (
        project.description !== undefined &&
        project.description !== null &&
        typeof project.description !== "string"
      )
        throw new Error("LINEAR_INVALID_RESPONSE");
      capture?.(project);
      return [
        `# ${label(string(project, "name"))}`,
        "",
        `URL: ${url}`,
        `Status: ${status(project)}`,
        ...(typeof project.uuid === "string" && isDocumentId(project.uuid)
          ? [`Editable description: linear://${page.workspace}/project/${project.uuid}/description`]
          : []),
        "",
        ...(links
          ? [`## Resources (${links.length})`, ...links, ""]
          : ["Resources are not exposed by this backend.", ""]),
        typeof project.description === "string" ? project.description : "",
      ].join("\n");
    }
    const team = object(
      decodeAxiObject(
        await run(cwd, ["teams", "view", page.identifier, "--full"], signal),
        "team",
        ["id", "key", "name", "visibility", "createdAt", "updatedAt"],
      ).team,
    );
    string(team, "id");
    if (string(team, "key").toLowerCase() !== page.identifier.toLowerCase()) mismatch();
    string(team, "name");
    const issues = async (limit: number, cursor?: string) => {
      const result = list(
        await run(
          cwd,
          [
            "issues",
            "list",
            "--team",
            string(team, "key"),
            "--all-projects",
            "--limit",
            String(limit),
            "--fields",
            "id,title,url,teamId,status",
            ...(cursor ? ["--cursor", cursor] : []),
          ],
          signal,
        ),
        "issues",
      );
      result.rows.forEach((row) => checkIssue(row, page, team));
      return result;
    };
    const projects = async (limit: number, cursor?: string) => {
      const result = list(
        await run(
          cwd,
          [
            "projects",
            "list",
            "--team",
            string(team, "key"),
            "--limit",
            String(limit),
            "--fields",
            "id,name,url,status,teams",
            ...(cursor ? ["--cursor", cursor] : []),
          ],
          signal,
        ),
        "projects",
      );
      result.rows.forEach((row) => checkProject(row, page, team));
      return result;
    };
    // get_team has no workspace identity. Verify it against one canonical linked URL;
    // an empty team with no such resource cannot safely establish its workspace.
    const witness = async (issuesChecked = false) => {
      if (!issuesChecked && (await issues(1)).rows.length) return;
      if ((await projects(1)).rows.length) return;
      throw new Error("LINEAR_WORKSPACE_UNVERIFIED");
    };
    const heading = `# ${label(team.name)} (${label(team.key)})`;
    const base = `https://linear.app/${page.workspace}/team/${page.identifier}`;
    if (page.kind === "team-overview") {
      await witness();
      capture?.(team);
      return [
        heading,
        "",
        `URL: ${page.source}`,
        `Visibility: ${label(team.visibility)}`,
        `Created: ${label(team.createdAt)}`,
        `Updated: ${label(team.updatedAt)}`,
        "",
        `Issues: <${base}/all>`,
        `Projects: <${base}/projects/all>`,
        "",
        "Pinned resources are not exposed by the current AXI/MCP backend. This is the available team card, not a browser snapshot.",
      ].join("\n");
    }
    const isIssues = page.kind === "team-issues";
    const result = await (isIssues ? issues(50, page.cursor) : projects(50, page.cursor));
    if (!result.rows.length) {
      if (isIssues) await witness(true);
      else if (!(await issues(1)).rows.length) throw new Error("LINEAR_WORKSPACE_UNVERIFIED");
    }
    const next = new URL(page.source);
    if (result.cursor) {
      if (result.cursor === page.cursor) throw new Error("LINEAR_INVALID_RESPONSE");
      next.searchParams.set("cursor", result.cursor);
    }
    capture?.(
      { items: result.rows, cursor: result.cursor ?? null },
      result.cursor
        ? `Coverage: this page only.\nNext page: ${next.href}`
        : "No continuation cursor returned; completeness is not independently confirmed.",
    );
    return [
      heading + (isIssues ? " — Issues" : " — Projects"),
      "",
      `URL: ${page.source}`,
      `Items on this page: ${result.rows.length} (page size at most 50)`,
      result.cursor
        ? `Next page (more available): <${next.href}>`
        : "End of list (no continuation cursor returned).",
      "",
      ...result.rows.map(
        (row) =>
          `- ${label(isIssues ? row.id : row.name)}${isIssues ? `: ${label(row.title)}` : ""} — ${status(row)}: <${string(row, "url")}>`,
      ),
    ].join("\n");
  };
}

/** Live page reader using the configured authenticated AXI CLI. */
export const readAxiPage: PageReader = createAxiPageReader();

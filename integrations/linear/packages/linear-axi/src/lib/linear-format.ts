import { asArrayOfUnknown, asRecord, type InputRecord } from "#axi/types.ts";
import { asArray } from "./mcp-tools.ts";
import { valueText } from "./value-text.ts";

const FIELD_HINTS: Record<string, string | undefined> = {
  issues: "id,title,state,assignee",
  documents: "id,title,updatedAt",
  projects: "id,name,status",
  teams: "id,name,key",
  users: "id,name,email",
};

const STATUS_RANKS: Record<string, number | undefined> = {
  "in progress": 0,
  started: 0,
  planned: 1,
  todo: 1,
  "to do": 1,
  backlog: 2,
};

export function compactRows(alias: string, data: unknown) {
  if (alias === "issues") return compactIssues(data);
  if (alias === "projects") return compactProjects(data);
  return asArray(data).map((item) => ({
    id: item.id ?? item.identifier ?? item.key ?? item.slug ?? item.name ?? "",
    name: item.name ?? item.title ?? item.displayName ?? item.email ?? "",
    state: rowState(item),
  }));
}

export function parseFields(fields: string): string[] {
  return fields
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
}

export function fieldHint(publicName: string): string {
  return FIELD_HINTS[publicName] ?? "id,name,state";
}

export function selectFields(
  items: readonly InputRecord[],
  fields: readonly string[],
): InputRecord[] {
  return items.map((item) => {
    const selected: InputRecord = {};
    for (const field of fields) {
      selected[field] = fieldValue(item, field);
    }
    return selected;
  });
}

export function paginationInfo(value: unknown, rowCount: number) {
  const data = asRecord(value);
  const pageInfo = asRecord(data?.pageInfo);
  const total = data?.totalCount ?? data?.total ?? pageInfo?.totalCount;
  const hasNextPageValue = data?.hasNextPage ?? pageInfo?.hasNextPage;
  const rawCursor = data?.cursor ?? data?.nextCursor ?? pageInfo?.endCursor;
  const cursor = typeof rawCursor === "string" ? rawCursor : undefined;
  const hasCursor = Boolean(cursor);
  const hasNextPage = hasNextPageValue === undefined ? hasCursor : Boolean(hasNextPageValue);
  return {
    count:
      typeof total === "number"
        ? `${rowCount} of ${total} total`
        : `${rowCount} returned${hasNextPage ? " (more available)" : ""}`,
    cursor: hasNextPage ? cursor : undefined,
  };
}

export function compactComment(comment: InputRecord) {
  const body = formattedPreview(comment.body ?? "", 120);
  return {
    id: comment.id ?? "",
    author: asRecord(comment.user)?.name ?? asRecord(comment.author)?.name ?? "",
    created: comment.createdAt ?? "",
    body: body.text,
    truncated: body.truncated,
  };
}

export function compactIssues(data: unknown) {
  return groupByStatusPriority(
    asArray(data).map((issue) => ({
      state: rowState(issue),
      title: issue.title ?? "",
      assignee: personName(issue.assignee),
      id: issue.identifier ?? issue.id ?? "",
    })),
  );
}

function compactProjects(data: unknown) {
  return groupByStatusPriority(
    asArray(data).map((project) => ({
      status: projectStatus(project),
      name: project.name ?? project.title ?? "",
      id: project.id ?? project.identifier ?? "",
    })),
  );
}

export function compactIssueDetail(value: unknown) {
  const issue = asRecord(value) ?? {};
  const description = valueText(issue.description ?? issue.body ?? "");
  const preview = formattedPreview(description, 1000);
  return {
    truncated: preview.truncated,
    issue: {
      id: issue.identifier ?? issue.id ?? "",
      title: issue.title ?? "",
      state: issueState(issue),
      assignee: personName(issue.assignee),
      description: preview.text,
      url: issue.url ?? "",
    },
  };
}

export function compactIssueMutation(value: unknown) {
  const issue = asRecord(value) ?? {};
  return {
    id: issue.identifier ?? issue.id ?? "",
    title: issue.title ?? "",
    state: issueState(issue),
    project: namedValue(issue.project),
    team: namedValue(issue.team),
    url: issue.url ?? "",
  };
}

export function compactProjectMutation(value: unknown) {
  const project = asRecord(value) ?? {};
  const firstTeam = asArrayOfUnknown(project.teams)?.[0];
  return {
    id: project.id ?? "",
    name: project.name ?? "",
    status: projectStatus(project),
    team: asRecord(project.team)?.name ?? asRecord(firstTeam)?.name ?? project.team ?? "",
    url: project.url ?? "",
  };
}

export function compactDocumentMutation(value: unknown) {
  const document = asRecord(value) ?? {};
  return {
    id: document.id ?? "",
    title: document.title ?? document.name ?? "",
    team: namedValue(document.team),
    project: namedValue(document.project),
    url: document.url ?? "",
  };
}

export function compactDocumentDetail(value: unknown, id?: string) {
  const document = asRecord(value) ?? {};
  const content = rewriteMcpHints(valueText(document.content ?? document.body ?? ""), id);
  const preview = formattedPreview(content, 1200);
  return {
    truncated: preview.truncated,
    document: {
      id: document.id ?? id ?? "",
      title: document.title ?? document.name ?? "",
      content: preview.text,
      team: namedValue(document.team),
      project: namedValue(document.project),
      url: document.url ?? "",
    },
  };
}

export function sanitizeDocument(value: unknown, id?: string): unknown {
  const document = asRecord(value);
  if (!document) return value;
  return {
    ...document,
    content:
      document.content === undefined
        ? document.content
        : rewriteMcpHints(valueText(document.content), id ?? document.id),
  };
}

function fieldValue(item: InputRecord, field: string): unknown {
  let value: unknown = item;
  for (const part of field.split(".")) {
    const record = asRecord(value);
    const array = asArrayOfUnknown(value);
    if (array && part === "length") value = array.length;
    else if (array && /^(?:0|[1-9][0-9]*)$/u.test(part)) value = array[Number(part)];
    else value = record?.[part];
  }
  if (value === undefined) return "";
  if (value === null) return null;
  if (typeof value === "object") {
    const record = asRecord(value);
    return (
      record?.name ??
      record?.displayName ??
      record?.identifier ??
      record?.id ??
      JSON.stringify(value)
    );
  }
  return value;
}

function rowState(item: InputRecord): unknown {
  return (
    asRecord(item.state)?.name ?? asRecord(item.status)?.name ?? item.state ?? item.status ?? ""
  );
}

function issueState(issue: InputRecord): unknown {
  return asRecord(issue.state)?.name ?? issue.status ?? issue.state ?? "";
}

function projectStatus(project: InputRecord): unknown {
  return (
    asRecord(project.status)?.name ??
    asRecord(project.state)?.name ??
    project.status ??
    project.state ??
    ""
  );
}

function personName(person: unknown): unknown {
  const record = asRecord(person);
  return record?.name ?? record?.displayName ?? person ?? "";
}

function namedValue(value: unknown): unknown {
  return asRecord(value)?.name ?? value ?? "";
}

interface StatusItem {
  status?: unknown;
  state?: unknown;
}

function groupByStatusPriority<T extends StatusItem>(items: T[]): T[] {
  return items.sort((left, right) => {
    const leftStatus = statusLabel(left.status ?? left.state);
    const rightStatus = statusLabel(right.status ?? right.state);
    const rankDifference = (STATUS_RANKS[leftStatus] ?? 3) - (STATUS_RANKS[rightStatus] ?? 3);
    return rankDifference || leftStatus.localeCompare(rightStatus);
  });
}

function statusLabel(value: unknown): string {
  return valueText(value ?? "")
    .trim()
    .toLowerCase();
}

function formattedPreview(value: unknown, limit: number) {
  const text = valueText(value ?? "");
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}... (truncated, ${text.length} chars total)`,
    truncated: true,
  };
}

function rewriteMcpHints(text: string, id: unknown): string {
  const replacement = id
    ? `run \`linear-axi documents view ${valueText(id)} --full\``
    : "run `linear-axi documents view <id> --full`";
  return text.replace(/use `get_document`/g, replacement);
}

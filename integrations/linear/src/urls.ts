/** A validated Linear issue location; workspace identity is part of the source. */
export interface IssueUrl {
  readonly workspace: string;
  readonly identifier: string;
  readonly source: string;
}

/** A document location, using a native URL or a stable provider link with a document UUID. */
export interface DocumentUrl {
  readonly workspace: string;
  readonly identifier: string;
  readonly source: string;
  readonly native: boolean;
}

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** Test a document UUID before constructing an address from backend data. */
export function isDocumentId(value: string): boolean {
  return uuid.test(value);
}

function ownedUrl(source: string, preserveSearch = false): URL | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "linear:" && url.hostname !== "linear.app") return undefined;
  if (
    url.protocol === "https:" &&
    ["docs", "developers", "oauth", "login", "settings"].includes(url.pathname.split("/")[1] ?? "")
  )
    return undefined;
  if (
    (url.protocol !== "https:" && url.protocol !== "linear:") ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("LINEAR_INVALID_URL");
  if (!preserveSearch) url.search = "";
  url.hash = "";
  return url;
}

/** Claim Linear issue URLs only, without allowing unsupported pages to fall back to the web. */
export function parseIssueUrl(source: string): IssueUrl | undefined {
  const url = ownedUrl(source);
  if (!url) return undefined;
  const match = /^\/([A-Za-z0-9_-]+)\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^/]+)?\/?$/u.exec(
    url.pathname,
  );
  if (url.protocol !== "https:" || !match) throw new Error("LINEAR_INVALID_URL");
  return { workspace: match[1], identifier: match[2], source: url.href };
}

/** Parse native document URLs and stable linear://workspace/document/UUID links. */
export function parseDocumentUrl(source: string): DocumentUrl | undefined {
  const url = ownedUrl(source);
  if (!url) return undefined;
  if (url.protocol === "linear:") {
    const match = /^\/document\/([^/]+)\/?$/u.exec(url.pathname);
    if (!/^[A-Za-z0-9_-]+$/u.test(url.hostname) || !match || !isDocumentId(match[1])) {
      throw new Error("LINEAR_INVALID_URL");
    }
    return {
      workspace: url.hostname,
      identifier: match[1].toLowerCase(),
      source: url.href,
      native: false,
    };
  }
  const match = /^\/([A-Za-z0-9_-]+)\/document\/([^/]+)\/?$/u.exec(url.pathname);
  if (!match) return undefined;
  const identifier = isDocumentId(match[2])
    ? match[2].toLowerCase()
    : /(?:^|-)([0-9a-f]{12})$/iu.exec(match[2])?.[1].toLowerCase();
  if (!identifier) throw new Error("LINEAR_INVALID_URL");
  return { workspace: match[1], identifier, source: url.href, native: true };
}

/** Give an issue-linked document a stable Read address without fetching its body. */
export function documentLink(workspace: string, id: string): string {
  if (!isDocumentId(id)) throw new Error("LINEAR_INVALID_RESPONSE");
  return `linear://${workspace}/document/${id.toLowerCase()}`;
}

/** One supported team/project page; list cursors belong to the resource identity. */
export interface PageUrl {
  readonly kind: "team-overview" | "team-issues" | "team-projects" | "project";
  readonly workspace: string;
  readonly identifier: string;
  readonly source: string;
  readonly cursor?: string;
}

/** Parse the supported native team/project views without claiming other Linear pages. */
export function parsePageUrl(source: string): PageUrl | undefined {
  const url = ownedUrl(source, true);
  if (!url || url.protocol !== "https:") return undefined;
  const team =
    /^\/([A-Za-z0-9_-]+)\/team\/([A-Za-z][A-Za-z0-9_-]*)\/(overview|all|projects\/all)\/?$/u.exec(
      url.pathname,
    );
  const project = /^\/([A-Za-z0-9_-]+)\/project\/([^/]+)(?:\/overview)?\/?$/u.exec(url.pathname);
  let kind: PageUrl["kind"];
  let workspace: string;
  let identifier: string;
  if (team) {
    workspace = team[1];
    identifier = team[2];
    kind =
      team[3] === "overview"
        ? "team-overview"
        : team[3] === "all"
          ? "team-issues"
          : "team-projects";
  } else if (project) {
    workspace = project[1];
    identifier = isDocumentId(project[2])
      ? project[2].toLowerCase()
      : (/(?:^|-)([0-9a-f]{12})$/iu.exec(project[2])?.[1].toLowerCase() ?? "");
    if (!identifier) return undefined;
    kind = "project";
  } else return undefined;
  const cursor = url.searchParams.get("cursor");
  const list = kind === "team-issues" || kind === "team-projects";
  if (
    Array.from(url.searchParams.keys()).some((key) => key !== "cursor") ||
    url.searchParams.getAll("cursor").length > 1 ||
    (cursor !== null && (!list || !cursor || cursor.length > 1024 || /[\r\n]/u.test(cursor)))
  ) {
    throw new Error("LINEAR_INVALID_URL");
  }
  return { kind, workspace, identifier, source: url.href, ...(cursor === null ? {} : { cursor }) };
}

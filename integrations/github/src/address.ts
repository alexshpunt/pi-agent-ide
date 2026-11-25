/** One repository-qualified resource. Query parameters never override its owner or repository. */
export interface GithubAddress {
  readonly owner: string;
  readonly repo: string;
  readonly parts: readonly string[];
  readonly facet?: string;
  readonly parameters: URLSearchParams;
  readonly source: string;
}

const roots = new Set([
  "issues",
  "pulls",
  "discussions",
  "discussion-comments",
  "releases",
  "labels",
  "milestones",
  "file",
  "search",
]);
const queryKeys = new Set([
  "page",
  "per_page",
  "cursor",
  "q",
  "kind",
  "ref",
  "path",
  "state",
  "sort",
  "direction",
]);

/** Claim supported native GitHub links and github: resources, without swallowing unrelated web pages. */
export function parseGithubAddress(source: string): GithubAddress | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  const native = url.protocol === "https:" && url.hostname === "github.com";
  if (url.protocol !== "github:" && !native) return undefined;
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    native &&
    (segments.length < 2 ||
      ["settings", "orgs", "login", "apps", "marketplace", "topics", "search"].includes(
        segments[0],
      ))
  )
    return undefined;
  if (url.username || url.password || url.port) throw new Error("GH_INVALID_URI");
  const owner = native ? segments.shift() : url.hostname;
  const repo = segments.shift();
  if (
    !owner ||
    !repo ||
    !/^[A-Za-z0-9-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo) ||
    /^\.{1,2}$/.test(repo)
  )
    throw new Error("GH_INVALID_URI");
  let parts = segments.map((part) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new Error("GH_INVALID_URI");
    }
    if (/[/\\?#%\u0000-\u001F\u007F]/u.test(decoded) || !decoded || /^\.{1,2}$/.test(decoded))
      throw new Error("GH_INVALID_URI");
    return decoded;
  });
  if (native && ["blob", "tree"].includes(parts[0]))
    throw new Error("GH_EXPLICIT_FILE_REF_REQUIRED");
  if (native && parts[0] === "pull") parts[0] = "pulls";
  if (native && parts[0] === "milestone") parts[0] = "milestones";
  if (parts.length && !roots.has(parts[0])) {
    if (native) return undefined;
    throw new Error("GH_INVALID_URI");
  }
  let facet = url.hash ? decodeURIComponent(url.hash.slice(1)) : undefined;
  if (native && facet) {
    const ordinary = /^issuecomment-(\d+)$/.exec(facet);
    const inline = /^discussion_r(\d+)$/.exec(facet);
    const review = /^pullrequestreview-(\d+)$/.exec(facet);
    if (ordinary && ["issues", "pulls"].includes(parts[0])) {
      parts = ["issues", "comments", ordinary[1]];
      facet = undefined;
    } else if (inline && parts[0] === "pulls") {
      parts = ["pulls", "comments", inline[1]];
      facet = undefined;
    } else if (review && parts[0] === "pulls" && parts[1]) {
      parts = ["pulls", parts[1], "reviews", review[1]];
      facet = undefined;
    }
  }
  if (facet && !/^[A-Za-z][A-Za-z0-9_-]*$/.test(facet)) throw new Error("GH_INVALID_URI");
  for (const [key] of url.searchParams) {
    if (!queryKeys.has(key) || url.searchParams.getAll(key).length !== 1)
      throw new Error("GH_INVALID_URI");
  }
  if (
    native &&
    parts.length === 1 &&
    ["issues", "pulls", "discussions"].includes(parts[0]) &&
    url.searchParams.has("q")
  ) {
    url.searchParams.set("kind", parts[0]);
    parts = ["search"];
  }
  const canonical = new URL(
    `github://${owner.toLowerCase()}/${repo}${parts.length ? "/" + parts.map(encodeURIComponent).join("/") : ""}`,
  );
  canonical.search = url.search;
  if (facet) canonical.hash = facet;
  return {
    owner: owner.toLowerCase(),
    repo,
    parts,
    ...(facet ? { facet } : {}),
    parameters: new URLSearchParams(url.searchParams),
    source: canonical.href,
  };
}

/** Build one canonical sibling/child resource without changing repository identity. */
export function githubSource(
  address: Pick<GithubAddress, "owner" | "repo">,
  path = "",
  facet?: string,
): string {
  return `github://${address.owner}/${address.repo}${path ? "/" + path : ""}${facet ? "#" + facet : ""}`;
}

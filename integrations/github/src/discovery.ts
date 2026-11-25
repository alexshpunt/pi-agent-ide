import { ResourceError } from "pi-agent-ide/api/resource";
import { GithubApiError } from "./client.ts";
import { githubSource, parseGithubAddress } from "./address.ts";
import type { GithubClientProvider } from "./backend.ts";
import type { GithubObjectPage, GithubObjectSearch } from "./search.ts";

/** Use GitHub's native issue/PR search, with an explicit repository and a bounded result page. */
export async function discoverGithub(
  provider: GithubClientProvider,
  request: GithubObjectSearch,
  cwd: string,
  signal?: AbortSignal,
): Promise<GithubObjectPage> {
  const scope = parseGithubAddress(request.scope);
  if (
    !scope ||
    (scope.parts.length && scope.parts[0] !== "search") ||
    scope.facet ||
    !["issues", "pulls"].includes(request.kind)
  )
    throw new ResourceError("GH_INVALID_SEARCH_SCOPE", request.scope, "not-applied");
  if (/(?:^|\s)(?:repo|org|user):/i.test(request.term) || request.term.length > 4096)
    throw new ResourceError("GH_SEARCH_SCOPE_OVERRIDE", scope.source, "not-applied");
  for (const [key] of scope.parameters)
    if (!["page", "per_page", "q", "kind"].includes(key))
      throw new ResourceError("GH_UNSUPPORTED_QUERY", scope.source, "not-applied");
  if (!Number.isSafeInteger(request.limit) || request.limit < 1)
    throw new ResourceError("GH_SEARCH_PAGE_LIMIT", scope.source, "not-applied");
  const maximum = Math.min(request.limit, 50);
  const page = Number(scope.parameters.get("page") ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page * maximum > 1000 || maximum < 1)
    throw new ResourceError("GH_SEARCH_PAGE_LIMIT", scope.source, "not-applied");
  const query =
    `repo:${scope.owner}/${scope.repo} is:${request.kind === "pulls" ? "pr" : "issue"} ${request.term}`.trim();
  let result;
  try {
    result = await (
      await provider(cwd)
    ).rest<{
      items: Record<string, unknown>[];
      total_count: number;
      incomplete_results: boolean;
    } | null>(
      "GET",
      `/search/issues?${new URLSearchParams({ q: query, page: String(page), per_page: String(maximum) })}`,
      undefined,
      signal,
    );
  } catch (error) {
    if (error instanceof GithubApiError)
      throw new ResourceError(error.code, scope.source, error.effect, { metadata: error.metadata });
    throw error;
  }
  if (
    !result.data ||
    !Array.isArray(result.data.items) ||
    result.data.items.length > maximum ||
    !Number.isSafeInteger(result.data.total_count) ||
    result.data.total_count < 0 ||
    typeof result.data.incomplete_results !== "boolean"
  )
    throw new ResourceError("GH_INVALID_RESPONSE", scope.source, "not-applied");
  const items = result.data.items.map((row) => {
    const target = typeof row.html_url === "string" ? parseGithubAddress(row.html_url) : undefined;
    if (
      !target ||
      target.owner !== scope.owner ||
      target.repo.toLowerCase() !== scope.repo.toLowerCase() ||
      target.parts[0] !== request.kind ||
      !/^\d+$/.test(target.parts[1] ?? "") ||
      typeof row.title !== "string"
    )
      throw new ResourceError("GH_SEARCH_IDENTITY_MISMATCH", scope.source, "not-applied");
    return { id: String(row.number), title: row.title, url: target.source };
  });
  let next: string | undefined;
  if (result.next && page * maximum < 1000) {
    const link = new URL(result.next);
    const nextPage = Number(link.searchParams.get("page"));
    if (
      link.origin !== "https://api.github.com" ||
      link.pathname !== "/search/issues" ||
      link.searchParams.get("q") !== query ||
      !Number.isSafeInteger(nextPage) ||
      nextPage !== page + 1
    )
      throw new ResourceError("GH_INVALID_CONTINUATION", scope.source, "not-applied");
    next =
      githubSource(scope, "search") +
      "?" +
      new URLSearchParams({
        kind: request.kind,
        q: request.term,
        page: String(nextPage),
        per_page: String(maximum),
      });
  }
  return {
    kind: request.kind,
    repository: `${scope.owner}/${scope.repo}`,
    term: request.term,
    items,
    complete: !next && !result.data.incomplete_results && page * maximum >= result.data.total_count,
    ...(next ? { next } : {}),
    notice:
      result.data.incomplete_results || result.data.total_count > 1000
        ? "GitHub search has incomplete results or a 1,000-result ceiling. No recursive scan was made."
        : "Native GitHub API search; linked bodies stay separate.",
  };
}

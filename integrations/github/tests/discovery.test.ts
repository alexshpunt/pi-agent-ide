import { expect, test } from "vitest";
import { discoverGithub } from "#github/discovery.ts";
import type { GithubClientProvider } from "#github/backend.ts";

const request = {
  scope: "github://example/project",
  repository: "example/project",
  kind: "issues",
  term: "target",
  limit: 2,
};
function fixture(data: unknown, next?: string) {
  const calls: string[] = [];
  const provider: GithubClientProvider = async () =>
    ({
      async rest(_method: string, route: string) {
        calls.push(route);
        return { data, next };
      },
    }) as never;
  return { calls, provider };
}
const issue = {
  number: 12,
  title: "Target",
  html_url: "https://github.com/example/project/issues/12",
};

test("native discovery stays in one repository and exposes a bounded next page", async () => {
  const query = "repo:example/project is:issue target";
  const next =
    "https://api.github.com/search/issues?" +
    new URLSearchParams({ q: query, page: "2", per_page: "2" });
  const f = fixture({ items: [issue], total_count: 3, incomplete_results: false }, next);
  const result = await discoverGithub(f.provider, request, ".");
  expect(result).toMatchObject({
    complete: false,
    items: [{ url: "github://example/project/issues/12" }],
  });
  expect(result.next).toBe(
    "github://example/project/search?kind=issues&q=target&page=2&per_page=2",
  );
  expect(new URL(f.calls[0], "https://api.github.com").searchParams.get("q")).toBe(query);
});

test("unsupported scope filters and invalid limits refuse before HTTP", async () => {
  const f = fixture({});
  for (const changed of [
    { scope: "github://example/project?state=closed" },
    { limit: NaN },
    { term: "repo:other/project" },
  ]) {
    await expect(discoverGithub(f.provider, { ...request, ...changed }, ".")).rejects.toMatchObject(
      { effect: "not-applied" },
    );
  }
  expect(f.calls).toEqual([]);
});

test("discovery refuses cross-repository results and wider pages", async () => {
  for (const items of [
    [{ ...issue, html_url: "https://github.com/other/project/issues/12" }],
    [issue, issue, issue],
  ]) {
    const f = fixture({ items, total_count: items.length, incomplete_results: false });
    await expect(discoverGithub(f.provider, request, ".")).rejects.toMatchObject({
      effect: "not-applied",
    });
  }
});

import type { SearchEnvironmentProvider } from "pi-agent-ide/api/search";
import { parseGithubAddress } from "./address.ts";
import { isGithubApiResource, githubApiUrl } from "./api.ts";
import type { ResourceTextReader } from "./search.ts";

/** Repository ownership for API discovery and scoped text search. */
export function githubLocation(
  source: string | undefined,
): { repository: string; resource: boolean } | undefined {
  if (!source) return undefined;
  if (isGithubApiResource(source)) {
    if (source.startsWith("https://")) {
      const route = new URL(githubApiUrl(source));
      const repo = /^\/repos\/([^/]+)\/([^/]+)(?:\/|$)/u.exec(route.pathname);
      return { repository: repo ? `${repo[1]}/${repo[2]}` : "", resource: true };
    }
    return { repository: "", resource: true };
  }
  try {
    const address = parseGithubAddress(source);
    if (address) return { repository: `${address.owner}/${address.repo}`, resource: true };
  } catch {
    // A verified context route can be outside the original typed route list.
  }
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.port || /[\\\u0000-\u0020]/u.test(source))
    return undefined;
  if (url.protocol === "https:" && url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 2)
      return {
        repository: ["orgs", "users", "settings", "apps"].includes(parts[0])
          ? ""
          : `${parts[0]}/${parts[1]}`,
        resource: true,
      };
  }
  if (url.protocol === "github:" && url.hostname !== "api") {
    const repo = url.pathname.split("/").find(Boolean);
    if (repo)
      return {
        repository: ["orgs", "users"].includes(url.hostname) ? "" : `${url.hostname}/${repo}`,
        resource: true,
      };
  }
  return undefined;
}

/** Keep Search snapshots on this provider; structural/shell queries never fall back locally. */
export function createGithubEnvironmentProvider(
  readText: ResourceTextReader,
): SearchEnvironmentProvider {
  return (request, context) => {
    if (
      !githubLocation(request.path) &&
      !context.scope?.targets.some((target) => githubLocation(target.source))
    )
      return undefined;
    const resolve = (_cwd: string, source: string) => {
      if (!githubLocation(source)) throw new Error("GH_INVALID_SEARCH_SCOPE");
      if (source.startsWith("https://api.github.com/")) return githubApiUrl(source);
      try {
        const address = parseGithubAddress(source);
        if (address) return address.source;
      } catch {
        /* Context and raw API readers validate their own resource routes. */
      }
      return source;
    };
    return {
      resolve,
      dirname(source) {
        const url = new URL(resolve(context.cwd, source));
        url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/"));
        url.hash = "";
        url.search = "";
        return url.href;
      },
      basename(source) {
        return new URL(resolve(context.cwd, source)).pathname.split("/").at(-1) ?? "";
      },
      async isDirectory() {
        return false;
      },
      async readText(source, signal) {
        return (await readText(resolve(context.cwd, source), context.cwd, signal)).content;
      },
      async runLines() {
        throw new Error("GH_SEARCH_OPTIONS_UNSUPPORTED");
      },
    };
  };
}

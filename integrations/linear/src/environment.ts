import type { SearchEnvironmentProvider } from "pi-agent-ide/api/search";
import type { ResourceTextReader } from "./search.ts";

/** True only for workspace application resources, not Linear's public docs or unrelated URLs. */
export function linearLocation(
  source: string | undefined,
): { workspace: string; resource: boolean } | undefined {
  if (!source) return undefined;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  if (url.protocol !== "linear:" && url.hostname !== "linear.app") return undefined;
  if (url.username || url.password || url.port) throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
  if (url.protocol === "linear:") {
    if (!/^[A-Za-z0-9_-]+$/u.test(url.hostname)) throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
    return { workspace: url.hostname, resource: !!url.pathname.replace(/\//gu, "") };
  }
  if (url.protocol !== "https:") return undefined;
  const match = /^\/([A-Za-z0-9_-]+)(?:\/(.*))?\/?$/u.exec(url.pathname);
  if (!match || ["docs", "developers", "oauth", "settings", "login"].includes(match[1]))
    return undefined;
  return { workspace: match[1], resource: !!match[2] };
}

/** A lazy read-only Search owner; no filesystem, shell or ripgrep fallback is allowed. */
export function createLinearEnvironmentProvider(
  readText: ResourceTextReader,
): SearchEnvironmentProvider {
  return (request, context) => {
    if (
      !linearLocation(request.path) &&
      !(
        context.scope?.targets.length &&
        context.scope.targets.every((target) => linearLocation(target.source))
      )
    )
      return undefined;
    const resolve = (_cwd: string, source: string) => {
      if (!linearLocation(source)) throw new Error("LINEAR_INVALID_SEARCH_SCOPE");
      return new URL(source).href;
    };
    return {
      resolve,
      dirname(source) {
        const url = new URL(resolve(context.cwd, source));
        url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/"));
        url.search = "";
        url.hash = "";
        return url.href;
      },
      basename(source) {
        return new URL(resolve(context.cwd, source)).pathname.split("/").at(-1) ?? "";
      },
      async isDirectory() {
        return false;
      },
      async readText(source, signal) {
        const snapshot = await readText(resolve(context.cwd, source), context.cwd, signal);
        if (snapshot.complete === false) throw new Error("LINEAR_RESOURCE_INCOMPLETE");
        return snapshot.content;
      },
      async runLines() {
        throw new Error("LINEAR_SEARCH_OPTIONS_UNSUPPORTED");
      },
    };
  };
}

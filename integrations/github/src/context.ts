import { createHash } from "node:crypto";
import { ResourceError } from "pi-agent-ide/api/resource";
import { GithubApiError } from "./client.ts";
import { githubJsonText, githubScalarText } from "./api.ts";
import type { GithubClientProvider } from "./backend.ts";

/** A readonly context view. Original file bytes stay separate from its readable presentation. */
export interface GithubContextSnapshot {
  source: string;
  content: string;
  bytes?: Uint8Array;
}

type Data = Record<string, unknown>;
interface Address {
  source: string;
  url: URL;
  parts: string[];
  owner: string;
  repo: string;
  route: string;
  kind:
    | "actions"
    | "checks"
    | "project"
    | "file"
    | "commit"
    | "compare"
    | "release"
    | "discussion"
    | "diff";
  projectOwner?: "organization" | "user";
}
const origin = "https://api.github.com";
const opaque = /^[A-Za-z0-9_.=-]+$/;
const sha = /^[a-f0-9]{40}$/i;
const maxPages = 20;
const encode = encodeURIComponent;
const pretty = (value: unknown) => githubJsonText(value);

function fail(code: string, source: string): never {
  throw new ResourceError(code, source, "not-applied");
}
function object(value: unknown, source: string): Data {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("GH_INVALID_RESPONSE", source);
  return value as Data;
}
function positive(value: unknown, source: string): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    fail("GH_INVALID_RESPONSE", source);
  return number;
}
function string(value: unknown, source: string): string {
  if (typeof value !== "string" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
    fail("GH_INVALID_RESPONSE", source);
  return value;
}
function commitSha(value: unknown, source: string): string {
  const valueString = string(value, source);
  if (!sha.test(valueString)) fail("GH_INVALID_RESPONSE", source);
  return valueString;
}
function api(address: Address, suffix = ""): string {
  return `${origin}/repos/${encode(address.owner)}/${encode(address.repo)}${suffix}`;
}
function bodyLink(address: Address, suffix: string): string {
  return `github://${address.owner}/${address.repo}/${suffix}`;
}
function fileLink(address: Address, ref: string, path: string): string {
  return bodyLink(address, `file?${new URLSearchParams({ ref, path })}`);
}
function repository(value: unknown, address: Address): void {
  const data = object(value, address.source);
  const name = data.full_name ?? data.nameWithOwner;
  if (
    typeof name !== "string" ||
    name.toLowerCase() !== `${address.owner}/${address.repo}`.toLowerCase()
  )
    fail("GH_IDENTITY_MISMATCH", address.source);
}
function repoUrl(value: unknown, address: Address): URL {
  let url: URL;
  try {
    url = new URL(string(value, address.source));
  } catch {
    fail("GH_INVALID_RESPONSE", address.source);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname.split("/")[1]?.toLowerCase() !== address.owner.toLowerCase() ||
    url.pathname.split("/")[2]?.toLowerCase() !== address.repo.toLowerCase()
  )
    fail("GH_IDENTITY_MISMATCH", address.source);
  return url;
}
function decodeParts(url: URL, source: string): string[] {
  try {
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (
      parts.some((part) => !part || /^\.{1,2}$/.test(part) || /[\\\u0000-\u001f\u007f]/u.test(part))
    )
      fail("GH_INVALID_URI", source);
    return parts;
  } catch {
    fail("GH_INVALID_URI", source);
  }
}
function parse(source: string): Address | undefined {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return undefined;
  }
  const native = url.protocol === "https:" && url.hostname === "github.com";
  const rest = url.protocol === "https:" && url.hostname === "api.github.com";
  if (!native && !rest && url.protocol !== "github:") return undefined;
  if (url.username || url.password || url.port || source.includes("\\"))
    fail("GH_INVALID_URI", source);
  const segments = decodeParts(url, source);
  let owner: string;
  let repo = "";
  let parts: string[];
  let kind: Address["kind"] | undefined;
  let projectOwner: Address["projectOwner"];
  if (
    (native || url.protocol === "github:") &&
    ["orgs", "users"].includes(native ? (segments[0] ?? "") : url.hostname)
  ) {
    const scope = native ? segments.shift() : url.hostname;
    owner = segments.shift() ?? "";
    if (segments[0] !== "projects") return undefined;
    projectOwner = scope === "orgs" ? "organization" : "user";
    parts = segments.slice(1);
    kind = "project";
  } else if (rest && segments[0] === "orgs" && segments[2] === "projectsV2") {
    // Keep an explicit REST resource on its original request semantics; the universal layer owns it.
    return undefined;
  } else {
    if (rest) {
      if (segments[0] !== "repos") return undefined;
      owner = segments[1] ?? "";
      repo = segments[2] ?? "";
      parts = segments.slice(3);
    } else {
      owner = native ? (segments.shift() ?? "") : url.hostname;
      repo = segments.shift() ?? "";
      parts = segments;
    }
    if (parts[0] === "actions") {
      if (parts.includes("logs") || parts.at(-1) === "zip") return undefined;
      if (
        !/^actions(?:\/(?:workflows(?:\/[^/]+(?:\/runs)?)?|runs(?:\/\d+(?:\/(?:jobs|artifacts)|\/attempts\/\d+|\/job\/\d+)?)?|jobs\/\d+|artifacts(?:\/\d+)?))?$/.test(
          parts.join("/"),
        )
      )
        return undefined;
      kind = "actions";
    } else if (
      rest &&
      ((parts[0] === "commits" && ["check-runs", "status", "statuses"].includes(parts[2] ?? "")) ||
        ["check-runs", "check-suites"].includes(parts[0] ?? ""))
    )
      kind = "checks";
    else if (native && parts[0] === "runs") {
      if (parts.length !== 2) fail("GH_INVALID_URI", source);
      positive(parts[1], source);
      for (const [key, value] of url.searchParams)
        if (
          key !== "check_suite_focus" ||
          url.searchParams.getAll(key).length !== 1 ||
          !["true", "false"].includes(value)
        )
          fail("GH_UNSUPPORTED_QUERY", source);
      kind = "checks";
    } else if (["pull", "pulls"].includes(parts[0] ?? "") && parts[2] === "checks") kind = "checks";
    else if (native && ["blob", "tree"].includes(parts[0] ?? "")) kind = "file";
    else if (
      (native && parts[0] === "commit") ||
      (rest && parts[0] === "commits" && parts.length === 2)
    )
      kind = "commit";
    else if (parts[0] === "compare") kind = "compare";
    else if (native && parts[0] === "releases" && ["tag", "download"].includes(parts[1] ?? ""))
      kind = "release";
    else if (native && parts[0] === "discussions" && url.hash) kind = "discussion";
    else if (native && parts[0] === "pull" && parts[2] === "files" && url.hash.startsWith("#diff-"))
      kind = "diff";
  }
  if (!kind) return undefined;
  if (!/^[A-Za-z0-9-]+$/.test(owner) || (kind !== "project" && !/^[A-Za-z0-9_.-]+$/.test(repo)))
    fail("GH_INVALID_URI", source);
  const base = `/repos/${encode(owner)}/${encode(repo)}`;
  const route = rest
    ? url.pathname + url.search
    : native && parts[0] === "runs"
      ? `${base}/check-runs/${positive(parts[1], source)}`
      : base;
  return {
    source,
    url,
    parts,
    owner,
    repo,
    route,
    kind,
    ...(projectOwner ? { projectOwner } : {}),
  };
}

/** Linked readonly views and verified browser URL resolution, using only the existing App client. */
export class GithubContext {
  constructor(readonly client: GithubClientProvider) {}

  /** Return undefined only for resources this context layer does not own. Owned failures are explicit. */
  async read(
    source: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubContextSnapshot | undefined> {
    const address = parse(source);
    if (!address) return undefined;
    const timeout = AbortSignal.timeout(20_000);
    signal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      if (address.kind === "file") return await this.#file(address, cwd, signal);
      if (address.kind === "release") return await this.#release(address, cwd, signal);
      if (address.kind === "discussion") return await this.#discussion(address, cwd, signal);
      if (address.kind === "project") return await this.#project(address, cwd, signal);
      if (address.kind === "diff") return await this.#diff(address, cwd, signal);
      if (address.kind === "checks" && ["pull", "pulls"].includes(address.parts[0] ?? ""))
        return await this.#prChecks(address, cwd, signal);
      return await this.#restView(address, cwd, signal);
    } catch (error) {
      if (error instanceof ResourceError) throw error;
      if (error instanceof GithubApiError)
        throw new ResourceError(error.code, source, error.effect, { metadata: error.metadata });
      if (signal.aborted)
        throw new ResourceError(
          signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
            ? "GH_TIMEOUT"
            : "GH_CANCELLED",
          source,
          "not-applied",
        );
      throw new ResourceError("GH_CONTEXT_FAILED", source, "not-applied");
    }
  }

  async #get(
    route: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{ data: unknown; next?: string }> {
    signal?.throwIfAborted();
    return (await this.client(cwd)).rest("GET", route, undefined, signal);
  }

  async #next(
    address: Address,
    current: string,
    next: string | undefined,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!next) return undefined;
    const before = new URL(current, origin);
    let after: URL;
    try {
      after = new URL(next);
    } catch {
      fail("GH_INVALID_CONTINUATION", address.source);
    }
    if (after.origin !== origin || after.username || after.password || after.hash)
      fail("GH_INVALID_CONTINUATION", address.source);
    if (after.pathname !== before.pathname) {
      const numeric = /^\/repositories\/(\d+)(\/.*)$/.exec(after.pathname);
      const expected = `/repos/${encode(address.owner)}/${encode(address.repo)}`;
      if (
        !numeric ||
        !before.pathname.startsWith(expected + "/") ||
        numeric[2] !== before.pathname.slice(expected.length)
      )
        fail("GH_INVALID_CONTINUATION", address.source);
      const root = object((await this.#get(expected, cwd, signal)).data, address.source);
      repository(root, address);
      if (positive(root.id, address.source) !== Number(numeric[1]))
        fail("GH_INVALID_CONTINUATION", address.source);
      after.pathname = before.pathname;
    }
    const comparable = (url: URL) => {
      const parameters = new URLSearchParams(url.search);
      parameters.delete("page");
      parameters.delete("after");
      parameters.delete("before");
      if (!parameters.has("per_page")) parameters.set("per_page", "30");
      parameters.sort();
      return parameters.toString();
    };
    if (comparable(before) !== comparable(after) || after.href === before.href)
      fail("GH_INVALID_CONTINUATION", address.source);
    if (after.searchParams.has("page")) {
      const from = Number(before.searchParams.get("page") ?? 1),
        to = Number(after.searchParams.get("page"));
      if (!Number.isInteger(to) || to <= from) fail("GH_INVALID_CONTINUATION", address.source);
    } else if (
      !after.searchParams.get("after") ||
      after.searchParams.get("after") === before.searchParams.get("after")
    )
      fail("GH_INVALID_CONTINUATION", address.source);
    return after.href;
  }

  async #pr(
    address: Address,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<Data & { number: number }> {
    if (address.parts.length !== 3) fail("GH_INVALID_URI", address.source);
    const number = positive(address.parts[1], address.source);
    const result = object(
      (await this.#get(`${address.route}/pulls/${number}`, cwd, signal)).data,
      address.source,
    );
    if (result.number !== number) fail("GH_IDENTITY_MISMATCH", address.source);
    const url = repoUrl(result.html_url, address);
    if (
      url.pathname.toLowerCase() !==
      `/${address.owner}/${address.repo}/pull/${number}`.toLowerCase()
    )
      fail("GH_IDENTITY_MISMATCH", address.source);
    return { ...result, number };
  }

  async #prChecks(
    address: Address,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubContextSnapshot> {
    if (address.url.search || address.url.hash) fail("GH_UNSUPPORTED_QUERY", address.source);
    const pull = await this.#pr(address, cwd, signal);
    const head = object(pull.head, address.source);
    const headSha = commitSha(head.sha, address.source);
    return {
      source: address.source,
      content: `# GitHub PR checks\nResource: ${address.source}\nPR: ${bodyLink(address, `pulls/${pull.number}`)}\nHead SHA: ${headSha}\nCheck runs: ${api(address, `/commits/${headSha}/check-runs`)}\nCommit status: ${api(address, `/commits/${headSha}/status`)}\nWorkflows: ${api(address, "/actions/workflows")}\nWorkflow runs: ${api(address, `/actions/runs?${new URLSearchParams({ head_sha: headSha })}`)}\n\nRead each linked resource separately. No check or workflow was executed.`,
    };
  }

  async #restView(
    address: Address,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubContextSnapshot> {
    let route = address.route;
    if (address.url.hostname !== "api.github.com") {
      const parts = [...address.parts];
      if (address.kind === "actions") {
        if (parts.length === 1) parts.push("workflows");
        if (parts[1] === "runs" && parts[3] === "job" && parts.length === 5) {
          positive(parts[2], address.source);
          positive(parts[4], address.source);
          route += `/actions/jobs/${parts[4]}`;
        } else route += "/" + parts.map(encode).join("/");
        route += address.url.search;
      } else if (address.kind === "commit") {
        const ref = parts.at(1);
        if (parts.length !== 2 || ref === undefined || address.url.hash)
          fail("GH_INVALID_URI", address.source);
        route += `/commits/${encode(ref)}` + address.url.search;
      } else if (address.kind === "compare") {
        if (parts.length < 2 || address.url.hash) fail("GH_INVALID_URI", address.source);
        const comparison = parts.slice(1).join("/");
        if (!/^.+\.\.\..+$/.test(comparison)) fail("GH_INVALID_URI", address.source);
        route += `/compare/${encode(comparison)}` + address.url.search;
      }
    }
    if (address.url.hash) fail("GH_UNSUPPORTED_FRAGMENT", address.source);
    const { data, next } = await this.#get(route, cwd, signal);
    const continuation = await this.#next(address, route, next, cwd, signal);
    const result = Array.isArray(data) ? data : object(data, address.source);
    const rows = Array.isArray(result) ? result : [result];
    const collection =
      !Array.isArray(result) && typeof result === "object"
        ? [
            "workflow_runs",
            "workflows",
            "jobs",
            "artifacts",
            "check_runs",
            "check_suites",
            "statuses",
          ].find((key) => Array.isArray(result[key]))
        : undefined;
    const entries = collection ? ((result as Data)[collection] as unknown[]) : rows;
    const lines = [
      `# GitHub ${address.kind} context`,
      `Resource: ${address.source}`,
      `API: ${new URL(route, origin).href}`,
    ];
    if (!Array.isArray(result) && typeof result.total_count === "number")
      lines.push(`Total: ${result.total_count}`);
    for (const value of entries) {
      const item = object(value, address.source);
      if (item.repository !== undefined) repository(item.repository, address);
      if (item.html_url !== undefined) {
        const browser = repoUrl(item.html_url, address);
        const browserParts = browser.pathname.split("/").filter(Boolean);
        if (
          address.parts[0] === "runs" &&
          browserParts[2] === "runs" &&
          (browserParts.length !== 4 ||
            positive(browserParts[3], address.source) !== Number(address.parts[1]))
        )
          fail("GH_IDENTITY_MISMATCH", address.source);
      }
      const routeParts = new URL(route, origin).pathname.split("/").filter(Boolean);
      const last = routeParts.at(-1);
      if (!last) fail("GH_INVALID_RESPONSE", address.source);
      const actionId =
        /\/actions\/(?:runs|jobs|artifacts|workflows)\/(\d+)(?:\/attempts\/\d+)?$/.exec(
          new URL(route, origin).pathname,
        )?.[1];
      const expectedId = actionId ?? (/^\d+$/.test(last) ? last : undefined);
      if (entries.length === 1 && !collection && expectedId && item.id !== Number(expectedId))
        fail("GH_IDENTITY_MISMATCH", address.source);
      if (address.kind === "commit" && sha.test(last) && item.sha !== last)
        fail("GH_IDENTITY_MISMATCH", address.source);
      if (
        /\/actions\/workflows\/[^/]+$/.test(new URL(route, origin).pathname) &&
        !/^\d+$/.test(last) &&
        item.path !== `.github/workflows/${decodeURIComponent(last)}`
      )
        fail("GH_IDENTITY_MISMATCH", address.source);
      if (
        address.kind === "actions" &&
        address.parts[3] === "job" &&
        item.run_id !== Number(address.parts[2])
      )
        fail("GH_IDENTITY_MISMATCH", address.source);
      lines.push(
        "",
        `## ${githubScalarText(item.name ?? item.title ?? item.id ?? item.sha, "Resource")}`,
      );
      for (const key of [
        "id",
        "status",
        "state",
        "context",
        "description",
        "conclusion",
        "event",
        "path",
        "run_number",
        "run_attempt",
        "head_branch",
        "head_sha",
        "ahead_by",
        "behind_by",
        "total_commits",
        "created_at",
        "updated_at",
        "started_at",
        "completed_at",
        "size_in_bytes",
        "expired",
      ])
        if (item[key] !== undefined)
          lines.push(`${key}: ${githubScalarText(item[key] ?? "null", "unavailable")}`);
      if (typeof item.html_url === "string") lines.push(`Browser: ${item.html_url}`);
      if (item.sha !== undefined)
        lines.push(`Commit: ${api(address, `/commits/${commitSha(item.sha, address.source)}`)}`);
      const type =
        route.includes("/actions/jobs") || collection === "jobs"
          ? "jobs"
          : collection === "workflows" || route.includes("/actions/workflows")
            ? "workflows"
            : collection === "artifacts" || route.includes("/actions/artifacts")
              ? "artifacts"
              : collection === "workflow_runs" || route.includes("/actions/runs")
                ? "runs"
                : undefined;
      if (type && item.id !== undefined) {
        const id = positive(item.id, address.source);
        const target = api(address, `/actions/${type}/${id}`);
        lines.push(`Read: ${target}`);
        if (type === "runs")
          lines.push(
            `Jobs: ${target}/jobs`,
            `Logs (original archive): ${target}/logs`,
            `Artifacts: ${target}/artifacts`,
          );
        if (type === "jobs") {
          lines.push(`Logs: ${target}/logs`);
          if (item.run_id !== undefined)
            lines.push(
              `Workflow run: ${api(address, `/actions/runs/${positive(item.run_id, address.source)}`)}`,
            );
        }
        if (type === "artifacts") lines.push(`Original archive: ${target}/zip`);
        if (type === "workflows") lines.push(`Runs: ${target}/runs`);
      }
      if (item.head_sha !== undefined)
        lines.push(
          `Head commit: ${api(address, `/commits/${commitSha(item.head_sha, address.source)}`)}`,
        );
      if (Array.isArray(item.steps)) {
        lines.push("### Steps");
        for (const step of item.steps) {
          const entry = object(step, address.source);
          lines.push(
            `- ${githubScalarText(entry.number, "")} ${githubScalarText(entry.name, "")}: ${githubScalarText(entry.status, "")} / ${githubScalarText(entry.conclusion, "")}`,
          );
        }
      }
      if (Array.isArray(item.pull_requests))
        for (const pull of item.pull_requests) {
          const entry = object(pull, address.source);
          lines.push(
            `Pull request: ${bodyLink(address, `pulls/${positive(entry.number, address.source)}`)}`,
          );
        }
      if (Array.isArray(item.parents))
        for (const parent of item.parents)
          lines.push(
            `Parent: ${api(address, `/commits/${commitSha(object(parent, address.source).sha, address.source)}`)}`,
          );
      if (item.commit && typeof item.commit === "object")
        lines.push(`Message: ${githubScalarText(object(item.commit, address.source).message, "")}`);
      if (Array.isArray(item.files)) {
        const head = item.sha ?? object(item.head_commit, address.source).sha;
        const ref = commitSha(head, address.source);
        for (const file of item.files) {
          const entry = object(file, address.source);
          lines.push(
            `File (${githubScalarText(entry.status, "")}): ${fileLink(address, ref, string(entry.filename, address.source))}`,
          );
        }
      }
      if (typeof item.details_url === "string") {
        let details: URL;
        try {
          details = new URL(item.details_url);
        } catch {
          fail("GH_INVALID_RESPONSE", address.source);
        }
        if (
          details.origin === "https://github.com" &&
          details.pathname.startsWith(`/${address.owner}/${address.repo}/`)
        )
          lines.push(`Details: ${details.href}`);
      }
      if (address.kind === "checks" && item.id !== undefined && !route.includes("/status"))
        lines.push(
          `Read: ${api(address, `/${collection === "check_suites" || route.includes("/check-suites") ? "check-suites" : "check-runs"}/${positive(item.id, address.source)}`)}`,
        );
    }
    if (continuation) lines.push("", "Coverage: incomplete.", `Next page: ${continuation}`);
    else if (collection || Array.isArray(result))
      lines.push("", "Coverage: this page is complete.");
    lines.push("", "## API metadata", pretty(data));
    return { source: address.source, content: lines.join("\n") };
  }

  async #file(address: Address, cwd: string, signal?: AbortSignal): Promise<GithubContextSnapshot> {
    if (address.url.search) fail("GH_UNSUPPORTED_QUERY", address.source);
    const tree = address.parts[0] === "tree";
    const segments = address.parts.slice(1).flatMap((part) => part.split("/"));
    const candidateCount = segments.length - (tree ? 0 : 1);
    if (candidateCount < 1 || candidateCount > 16) fail("GH_REF_LOOKUP_LIMIT", address.source);
    const matches: { ref: string; path: string; data: unknown }[] = [];
    for (let index = 1; index <= candidateCount; index++) {
      const candidate = segments.slice(0, index).join("/");
      const path = segments.slice(index).join("/");
      try {
        const commit = object(
          (await this.#get(`${address.route}/commits/${encode(candidate)}`, cwd, signal)).data,
          address.source,
        );
        const ref = commitSha(commit.sha, address.source);
        const route = `${address.route}/contents${path ? "/" + path.split("/").map(encode).join("/") : ""}?${new URLSearchParams({ ref })}`;
        const data = (await this.#get(route, cwd, signal)).data;
        if (
          tree
            ? Array.isArray(data)
            : !Array.isArray(data) && object(data, address.source).type === "file"
        )
          matches.push({ ref, path, data });
      } catch (error) {
        if (error instanceof GithubApiError && error.code === "GH_NOT_FOUND") continue;
        throw error;
      }
    }
    const selected = matches.at(0);
    if (!selected) fail("GH_NOT_FOUND", address.source);
    if (matches.length !== 1) fail("GH_AMBIGUOUS_REF", address.source);
    const lines = [
      `# GitHub ${tree ? "directory" : "file"}`,
      `Resource: ${address.source}`,
      `Commit: ${selected.ref}`,
      `Path: ${selected.path || "/"}`,
    ];
    if (tree) {
      if (address.url.hash) fail("GH_UNSUPPORTED_FRAGMENT", address.source);
      const items = selected.data as unknown[];
      for (const item of items) {
        const entry = object(item, address.source);
        const path = string(entry.path, address.source);
        const suffix = path.slice(selected.path ? selected.path.length + 1 : 0);
        if (
          (selected.path && !path.startsWith(selected.path + "/")) ||
          !suffix ||
          suffix.includes("/")
        )
          fail("GH_IDENTITY_MISMATCH", address.source);
        const target =
          entry.type === "dir"
            ? `https://github.com/${address.owner}/${address.repo}/tree/${selected.ref}/${path.split("/").map(encode).join("/")}`
            : fileLink(address, selected.ref, path);
        lines.push(`- ${githubScalarText(entry.type, "unavailable")}: ${path} — ${target}`);
      }
      if (items.length >= 1000)
        lines.push(
          "Coverage may be incomplete: the directory endpoint is limited to 1000 entries.",
          `Git tree: ${api(address, `/git/trees/${selected.ref}`)}`,
        );
      return { source: address.source, content: lines.join("\n") };
    }
    const data = object(selected.data, address.source);
    if (data.path !== selected.path) fail("GH_IDENTITY_MISMATCH", address.source);
    let bytes: Buffer;
    if (data.encoding === "none") {
      if (typeof data.size !== "number" || !Number.isSafeInteger(data.size) || data.size < 0)
        fail("GH_INVALID_RESPONSE", address.source);
      if (data.size > 2 * 1024 * 1024) fail("GH_RESPONSE_TOO_LARGE", address.source);
      const expectedBlob = commitSha(data.sha, address.source);
      const route = `${address.route}/contents/${selected.path.split("/").map(encode).join("/")}?${new URLSearchParams({ ref: selected.ref })}`;
      const response = await (
        await this.client(cwd)
      ).request("GET", route, undefined, signal, { accept: "application/vnd.github.raw+json" });
      bytes = Buffer.from(response.bytes);
      const actualBlob = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (
        response.status !== 200 ||
        bytes.length !== data.size ||
        actualBlob !== expectedBlob.toLowerCase()
      )
        fail("GH_FILE_CONTENT_MISMATCH", address.source);
      lines.push(
        `Verified browser file: https://github.com/${address.owner}/${address.repo}/blob/${selected.ref}/${selected.path.split("/").map(encode).join("/")}`,
      );
    } else {
      if (data.encoding !== "base64" || typeof data.content !== "string")
        fail("GH_FILE_CONTENT_UNAVAILABLE", address.source);
      const encoded = data.content.replace(/\s/g, "");
      bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) fail("GH_INVALID_RESPONSE", address.source);
      if (bytes.length > 2 * 1024 * 1024 || data.size !== bytes.length)
        fail("GH_INVALID_RESPONSE", address.source);
      lines.push(`Exact file: ${fileLink(address, selected.ref, selected.path)}`);
    }
    lines.push(`Original bytes: raw:${address.source}`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        source: address.source,
        content: lines
          .concat(
            "",
            "Binary file; use original-byte Read. No archive extraction or OCR was performed.",
          )
          .join("\n"),
        bytes,
      };
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
      return {
        source: address.source,
        content: lines.concat("", "Binary file; use original-byte Read.").join("\n"),
        bytes,
      };
    const range = address.url.hash ? /^#L(\d+)(?:-L(\d+))?$/.exec(address.url.hash) : undefined;
    if (address.url.hash && !range) fail("GH_UNSUPPORTED_FRAGMENT", address.source);
    if (range) {
      const from = positive(range[1], address.source),
        to = range[2] ? positive(range[2], address.source) : from;
      const sourceLines = text.split(/\r?\n/);
      if (text.endsWith("\n")) sourceLines.pop();
      if (to < from || to > sourceLines.length) fail("GH_LINE_OUT_OF_RANGE", address.source);
      lines.push(`Lines: ${from}-${to}`, "", sourceLines.slice(from - 1, to).join("\n"));
    } else lines.push("", text);
    return { source: address.source, content: lines.join("\n"), bytes };
  }

  async #release(
    address: Address,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubContextSnapshot> {
    if (address.url.search || address.url.hash) fail("GH_UNSUPPORTED_QUERY", address.source);
    const download = address.parts[1] === "download";
    const tag = address.parts.slice(2, download ? -1 : undefined).join("/");
    if (!tag || (download && address.parts.length < 4)) fail("GH_INVALID_URI", address.source);
    const expectedUrl = download
      ? `https://github.com/${address.owner}/${address.repo}/releases/tag/${address.parts.slice(2, -1).map(encode).join("/")}`
      : address.url.href;
    let release: Data;
    try {
      release = object(
        (await this.#get(`${address.route}/releases/tags/${encode(tag)}`, cwd, signal)).data,
        address.source,
      );
      if (
        release.tag_name !== tag &&
        (typeof release.html_url !== "string" ||
          repoUrl(release.html_url, address).href !== expectedUrl)
      )
        fail("GH_IDENTITY_MISMATCH", address.source);
    } catch (error) {
      if (!(error instanceof GithubApiError) || error.status !== 404) throw error;
      let route: string | undefined = `${address.route}/releases?per_page=100`;
      const matches: Data[] = [];
      for (let page = 0; route && page < maxPages; page++) {
        const response = await this.#get(route, cwd, signal);
        if (!Array.isArray(response.data)) fail("GH_INVALID_RESPONSE", address.source);
        for (const value of response.data) {
          const candidate = object(value, address.source);
          const url = repoUrl(candidate.html_url, address);
          if (
            !url.pathname
              .toLowerCase()
              .startsWith(`/${address.owner}/${address.repo}/releases/tag/`.toLowerCase())
          )
            fail("GH_IDENTITY_MISMATCH", address.source);
          if (url.href === expectedUrl) matches.push(candidate);
        }
        route = await this.#next(address, route, response.next, cwd, signal);
      }
      if (route) fail("GH_RELEASE_LOOKUP_INCOMPLETE", address.source);
      const candidate = matches.at(0);
      if (!candidate || matches.length !== 1)
        fail(candidate ? "GH_AMBIGUOUS_RELEASE" : "GH_NOT_FOUND", address.source);
      release = candidate;
      string(release.tag_name, address.source);
    }
    const id = positive(release.id, address.source);
    const lines = [
      "# GitHub release",
      `Resource: ${address.source}`,
      `Tag: ${githubScalarText(release.tag_name, "unavailable")}`,
      ...(release.tag_name !== tag ? [`Browser alias: ${tag}`] : []),
      `Release: ${bodyLink(address, `releases/${id}`)}`,
      `Assets: ${api(address, `/releases/${id}/assets`)}`,
    ];
    if (download) {
      const name = address.parts.at(-1);
      if (!name) fail("GH_INVALID_URI", address.source);
      let route: string | undefined = `${address.route}/releases/${id}/assets?per_page=100`;
      const matches: Data[] = [];
      for (let page = 0; route && page < maxPages; page++) {
        const result = await this.#get(route, cwd, signal);
        if (!Array.isArray(result.data)) fail("GH_INVALID_RESPONSE", address.source);
        for (const asset of result.data) {
          const data = object(asset, address.source);
          if (data.name === name) matches.push(data);
        }
        route = await this.#next(address, route, result.next, cwd, signal);
      }
      if (route) fail("GH_ASSET_LOOKUP_INCOMPLETE", address.source);
      const asset = matches.at(0);
      if (!asset || matches.length !== 1)
        fail(asset ? "GH_AMBIGUOUS_ASSET" : "GH_NOT_FOUND", address.source);
      const assetId = positive(asset.id, address.source);
      lines.push(
        `Asset: ${bodyLink(address, `releases/assets/${assetId}`)}`,
        `Original bytes: raw:${bodyLink(address, `releases/assets/${assetId}`)}`,
        `Name: ${name}`,
      );
    }
    return { source: address.source, content: lines.join("\n") };
  }

  async #project(
    address: Address,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubContextSnapshot> {
    const number = positive(address.parts[0], address.source);
    const scope = address.projectOwner === "organization" ? "orgs" : "users";
    const base = `github://${scope}/${address.owner}/projects/${number}`;
    const section = address.parts[1];
    if (address.url.hash) fail("GH_UNSUPPORTED_FRAGMENT", address.source);
    const viewNumber =
      section === "views" && address.parts[2]
        ? positive(address.parts[2], address.source)
        : undefined;
    const viewItems = viewNumber !== undefined && address.parts[3] === "items";
    if (
      (section === "views" && (address.parts.length > 4 || (address.parts[3] && !viewItems))) ||
      (section !== "views" &&
        (address.parts.length > 2 || (section && !["fields", "items"].includes(section))))
    )
      fail("GH_UNSUPPORTED_PROJECT_RESOURCE", address.source);
    for (const [key] of address.url.searchParams)
      if (
        !["per_page", "cursor"].includes(key) ||
        address.url.searchParams.getAll(key).length !== 1
      )
        fail(
          section === "views" ? "GH_UNSUPPORTED_PROJECT_SELECTION" : "GH_UNSUPPORTED_QUERY",
          address.source,
        );
    const first = Number(address.url.searchParams.get("per_page") ?? 30);
    if (!Number.isInteger(first) || first < 1 || first > 50)
      fail("GH_INVALID_PAGE", address.source);
    const cursor = address.url.searchParams.get("cursor");
    if (cursor !== null && (!cursor || cursor.length > 2048))
      fail("GH_INVALID_PAGE", address.source);
    if ((!section || (viewNumber !== undefined && !viewItems)) && address.url.search)
      fail("GH_UNSUPPORTED_PROJECT_SELECTION", address.source);
    const fieldSelection = `fields(first:$first,after:$after){nodes{__typename ... on ProjectV2Field{id name dataType} ... on ProjectV2SingleSelectField{id name options{id name}} ... on ProjectV2IterationField{id name configuration{iterations{id title startDate duration}}}}pageInfo{hasNextPage endCursor}}`;
    const itemSelection = `items(first:$first,after:$after${viewItems ? ",query:$filter" : ""}){nodes{id type content{__typename ... on Issue{number title url repository{nameWithOwner}} ... on PullRequest{number title url repository{nameWithOwner}} ... on DraftIssue{id title}}fieldValues(first:50){nodes{__typename ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldIterationValue{title field{... on ProjectV2FieldCommon{name}}}}pageInfo{hasNextPage endCursor}}}pageInfo{hasNextPage endCursor}}`;
    const expected = `https://github.com/${scope}/${address.owner}/projects/${number}`;
    const viewSelection = `id number name layout filter project{number url owner{__typename ... on Organization{login} ... on User{login}}}`;
    const viewFields = `fields(first:50){nodes{__typename ... on ProjectV2Field{id name dataType} ... on ProjectV2SingleSelectField{id name dataType} ... on ProjectV2IterationField{id name dataType}}pageInfo{hasNextPage endCursor}}`;
    const validateProject = (value: unknown): Data => {
      const project = object(value, address.source);
      if (
        project.number !== number ||
        typeof project.id !== "string" ||
        !opaque.test(project.id) ||
        typeof project.url !== "string" ||
        project.url.toLowerCase() !== expected.toLowerCase()
      )
        fail("GH_IDENTITY_MISMATCH", address.source);
      return project;
    };
    type ProjectView = Data & {
      number: number;
      name: string;
      layout: string;
      filter: string | null;
    };
    const validateView = (value: unknown, requested?: number): ProjectView => {
      if (value === null) fail("GH_NOT_FOUND", address.source);
      const view = object(value, address.source);
      const parent = object(view.project, address.source);
      const owner = object(parent.owner, address.source);
      if (
        parent.number !== number ||
        typeof parent.url !== "string" ||
        parent.url.toLowerCase() !== expected.toLowerCase() ||
        owner.__typename !== (scope === "orgs" ? "Organization" : "User") ||
        typeof owner.login !== "string" ||
        owner.login.toLowerCase() !== address.owner.toLowerCase() ||
        (requested !== undefined && view.number !== requested)
      )
        fail("GH_IDENTITY_MISMATCH", address.source);
      const viewId = positive(view.number, address.source);
      if (
        typeof view.id !== "string" ||
        !opaque.test(view.id) ||
        typeof view.name !== "string" ||
        typeof view.layout !== "string" ||
        !["BOARD_LAYOUT", "TABLE_LAYOUT", "ROADMAP_LAYOUT"].includes(view.layout) ||
        (view.filter !== null && typeof view.filter !== "string")
      )
        fail("GH_INVALID_RESPONSE", address.source);
      return { ...view, number: viewId, name: view.name, layout: view.layout, filter: view.filter };
    };
    const page = (
      value: unknown,
      limit: number,
      after?: string | null,
    ): { nodes: unknown[]; next?: string } => {
      const data = object(value, address.source);
      const info = object(data.pageInfo, address.source);
      if (
        !Array.isArray(data.nodes) ||
        data.nodes.length > limit ||
        typeof info.hasNextPage !== "boolean"
      )
        fail("GH_INVALID_RESPONSE", address.source);
      if (!info.hasNextPage) return { nodes: data.nodes };
      if (
        typeof info.endCursor !== "string" ||
        !info.endCursor ||
        info.endCursor.length > 2048 ||
        info.endCursor === after
      )
        fail("GH_INVALID_CONTINUATION", address.source);
      return { nodes: data.nodes, next: info.endCursor };
    };
    const readProject = async (
      extra: string,
      collection: boolean,
      filter?: string,
    ): Promise<Data> => {
      const filtered = filter !== undefined;
      const query = `query($owner:String!,$number:Int!${collection ? ",$first:Int!,$after:String" : ""}${viewNumber !== undefined ? ",$view:Int!" : ""}${filtered ? ",$filter:String!" : ""}){owner:${address.projectOwner}(login:$owner){login projectV2(number:$number){id number title url closed shortDescription ${extra}}}}`;
      const response = object(
        await (
          await this.client(cwd)
        ).graphql(
          query,
          {
            owner: address.owner,
            number,
            ...(collection ? { first, after: cursor } : {}),
            ...(viewNumber !== undefined ? { view: viewNumber } : {}),
            ...(filtered ? { filter } : {}),
          },
          signal,
        ),
        address.source,
      );
      const owner = object(response.owner, address.source);
      if (
        typeof owner.login !== "string" ||
        owner.login.toLowerCase() !== address.owner.toLowerCase()
      )
        fail("GH_IDENTITY_MISMATCH", address.source);
      return validateProject(owner.projectV2);
    };
    const extra =
      viewNumber !== undefined
        ? `view(number:$view){${viewSelection} ${viewFields}}`
        : section === "views"
          ? `views(first:$first,after:$after){nodes{${viewSelection}}pageInfo{hasNextPage endCursor}}`
          : section === "fields"
            ? fieldSelection
            : section === "items"
              ? itemSelection
              : "";
    let project = await readProject(extra, Boolean(section && viewNumber === undefined));
    const view = viewNumber !== undefined ? validateView(project.view, viewNumber) : undefined;
    if (viewItems && view && typeof view.filter === "string") {
      const nextProject = await readProject(`${extra} ${itemSelection}`, true, view.filter);
      const current = validateView(nextProject.view, viewNumber);
      if (nextProject.id !== project.id || current.id !== view.id || current.filter !== view.filter)
        fail("GH_STALE_PROJECT_VIEW", address.source);
      project = nextProject;
    }
    const lines = [
      "# GitHub Project",
      `Resource: ${address.source}`,
      `Title: ${githubScalarText(project.title, "unavailable")}`,
      `Project: ${base}`,
      `Browser: ${string(project.url, address.source)}`,
      `Closed: ${githubScalarText(project.closed, "unavailable")}`,
      `${view ? "Project fields" : "Fields"}: ${base}/fields`,
      `${view ? "Project items" : "Items"}: ${base}/items`,
      `Views: ${base}/views`,
    ];
    if (typeof project.shortDescription === "string" && project.shortDescription)
      lines.push(`Description: ${project.shortDescription}`);
    const viewLines = (value: ProjectView): string[] => [
      `View: ${base}/views/${value.number}`,
      `Name: ${value.name}`,
      `Layout: ${value.layout}`,
      `Saved filter: ${value.filter === null ? "unavailable" : value.filter || "(empty; no saved filter restriction)"}`,
      `Items: ${base}/views/${value.number}/items`,
      "Browser sorting and grouping are not reproduced; items use API connection order.",
    ];
    if (view) {
      lines.push("", ...viewLines(view));
      if (view.fields === null) {
        lines.push(
          "Visible fields are unavailable; send a targeted query through Write at github://api/graphql (endpoint https://api.github.com/graphql).",
        );
      } else {
        const fields = page(view.fields, 50);
        lines.push("Visible fields:", pretty(fields.nodes));
        if (fields.next)
          lines.push(
            "Visible fields are incomplete; send a targeted fields(after:...) query through Write at github://api/graphql (endpoint https://api.github.com/graphql) for the remaining fields.",
          );
      }
      if (viewItems && view.filter === null) {
        lines.push(
          "Saved filter is unavailable; no parent items were returned as filtered view items.",
          "Send a targeted ProjectV2.view(number:...) and items(query:...) query through Write at github://api/graphql (endpoint https://api.github.com/graphql).",
        );
        return { source: address.source, content: lines.join("\n") };
      }
    }
    const collection = viewItems ? "items" : viewNumber === undefined ? section : undefined;
    if (collection) {
      const connection = page(project[collection], first, cursor);
      for (const node of connection.nodes) {
        const item = object(node, address.source);
        lines.push("", `## ${githubScalarText(item.name ?? item.id, "unavailable")}`);
        if (collection === "views") lines.push(...viewLines(validateView(item)));
        else if (collection === "fields") lines.push(pretty(item));
        else {
          const content = item.content === null ? undefined : object(item.content, address.source);
          if (content) {
            lines.push(
              `Type: ${githubScalarText(content.__typename, "unavailable")}`,
              `Title: ${githubScalarText(content.title, "unavailable")}`,
            );
            if (["Issue", "PullRequest"].includes(String(content.__typename))) {
              const repo = object(content.repository, address.source);
              const name = string(repo.nameWithOwner, address.source);
              if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(name))
                fail("GH_INVALID_RESPONSE", address.source);
              const linked = `github://${name}/${content.__typename === "Issue" ? "issues" : "pulls"}/${positive(content.number, address.source)}`;
              const browser = `https://github.com/${name}/${content.__typename === "Issue" ? "issues" : "pull"}/${githubScalarText(content.number, "")}`;
              if (content.url !== browser) fail("GH_IDENTITY_MISMATCH", address.source);
              lines.push(`Content: ${linked}`);
            }
          } else lines.push("Content: unavailable to this installation.");
          const fields = page(item.fieldValues, 50);
          lines.push("Fields:", pretty(fields.nodes));
          if (fields.next)
            lines.push(
              "Field values are incomplete; use a targeted GraphQL query for remaining fields.",
            );
        }
      }
      if (connection.next) {
        const path = viewItems ? `views/${viewNumber}/items` : collection;
        lines.push(
          "Coverage: incomplete.",
          `Next page: ${base}/${path}?${new URLSearchParams({ per_page: String(first), cursor: connection.next })}`,
        );
      } else lines.push("Coverage: this page is complete.");
    }
    return { source: address.source, content: lines.join("\n") };
  }

  async #discussion(
    address: Address,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<GithubContextSnapshot> {
    if (address.parts.length !== 2 || address.url.search) fail("GH_INVALID_URI", address.source);
    const number = positive(address.parts[1], address.source);
    const fragment = /^#discussioncomment-(\d+)$/.exec(address.url.hash);
    if (!fragment) fail("GH_UNSUPPORTED_FRAGMENT", address.source);
    positive(fragment[1], address.source);
    const fields = `id url author{__typename login} discussion{number repository{nameWithOwner}}`;
    const pageInfo = `pageInfo{hasNextPage endCursor}`;
    const selection = `nodes{${fields} replies(first:50){nodes{${fields}}${pageInfo}}}${pageInfo}`;
    const query = `query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){nameWithOwner discussion(number:$number){number comments(first:50,after:$after){${selection}}}}}`;
    const replies = `query($id:ID!,$after:String){node(id:$id){... on DiscussionComment{${fields} replies(first:50,after:$after){nodes{${fields}}${pageInfo}}}}}`;
    let after: string | null = null;
    let requests = 0;
    const seenComments = new Set<string>();
    const inspect = (value: unknown): (Data & { id: string }) | undefined => {
      const comment = object(value, address.source);
      const discussion = object(comment.discussion, address.source);
      if (discussion.number !== number) fail("GH_IDENTITY_MISMATCH", address.source);
      repository(discussion.repository, address);
      const url = repoUrl(comment.url, address);
      if (
        url.pathname.toLowerCase() !==
          `/${address.owner}/${address.repo}/discussions/${number}`.toLowerCase() ||
        !/^#discussioncomment-\d+$/.test(url.hash)
      )
        fail("GH_IDENTITY_MISMATCH", address.source);
      if (typeof comment.id !== "string" || !opaque.test(comment.id))
        fail("GH_INVALID_RESPONSE", address.source);
      return url.hash === address.url.hash ? { ...comment, id: comment.id } : undefined;
    };
    const connection = (
      value: unknown,
      seen: Set<string>,
    ): { nodes: unknown[]; next: string | null } => {
      const data = object(value, address.source),
        info = object(data.pageInfo, address.source);
      if (
        !Array.isArray(data.nodes) ||
        data.nodes.length > 50 ||
        typeof info.hasNextPage !== "boolean"
      )
        fail("GH_INVALID_RESPONSE", address.source);
      const next = info.hasNextPage ? string(info.endCursor, address.source) : null;
      if (next !== null && (!next || seen.has(next)))
        fail("GH_INVALID_CONTINUATION", address.source);
      if (next) seen.add(next);
      return { nodes: data.nodes, next };
    };
    const found = (comment: Data & { id: string }): GithubContextSnapshot => ({
      source: address.source,
      content: [
        `# GitHub discussion comment`,
        `Resource: ${address.source}`,
        `Comment: ${bodyLink(address, `discussion-comments/${comment.id}`)}`,
        `Body: ${bodyLink(address, `discussion-comments/${comment.id}#body`)}`,
        `Discussion: ${bodyLink(address, `discussions/${number}`)}`,
        `Author: ${comment.author === null ? "Deleted or unavailable" : githubScalarText(object(comment.author, address.source).login, "Unavailable")}`,
        `Actor: ${comment.author === null ? "Unknown" : githubScalarText(object(comment.author, address.source).__typename, "Unknown")}`,
      ].join("\n"),
    });
    do {
      if (++requests > maxPages) fail("GH_COMMENT_LOOKUP_INCOMPLETE", address.source);
      const response = object(
        await (
          await this.client(cwd)
        ).graphql(query, { owner: address.owner, repo: address.repo, number, after }, signal),
        address.source,
      );
      const repo = object(response.repository, address.source);
      repository(repo, address);
      const discussion = object(repo.discussion, address.source);
      if (discussion.number !== number) fail("GH_IDENTITY_MISMATCH", address.source);
      const page = connection(discussion.comments, seenComments);
      for (const value of page.nodes) {
        const direct = inspect(value);
        if (direct) return found(direct);
        const parent = object(value, address.source);
        const seenReplies = new Set<string>();
        let replyPage = connection(parent.replies, seenReplies);
        for (;;) {
          for (const reply of replyPage.nodes) {
            const match = inspect(reply);
            if (match) return found(match);
          }
          if (!replyPage.next) break;
          if (++requests > maxPages) fail("GH_COMMENT_LOOKUP_INCOMPLETE", address.source);
          const next = object(
            await (
              await this.client(cwd)
            ).graphql(replies, { id: parent.id, after: replyPage.next }, signal),
            address.source,
          );
          const replyParent = object(next.node, address.source);
          inspect(replyParent);
          if (replyParent.id !== parent.id) fail("GH_IDENTITY_MISMATCH", address.source);
          replyPage = connection(replyParent.replies, seenReplies);
        }
      }
      after = page.next;
    } while (after);
    fail("GH_NOT_FOUND", address.source);
  }

  async #diff(address: Address, cwd: string, signal?: AbortSignal): Promise<GithubContextSnapshot> {
    if (address.url.search) fail("GH_UNSUPPORTED_QUERY", address.source);
    const match = /^#diff-([a-f0-9]{64})(?:([LR])(\d+)(?:-([LR])(\d+))?)?$/.exec(address.url.hash);
    if (!match) fail("GH_UNSUPPORTED_FRAGMENT", address.source);
    const pull = await this.#pr(address, cwd, signal);
    const number = positive(address.parts[1], address.source);
    let route: string | undefined = `${address.route}/pulls/${number}/files?per_page=100`;
    let file: Data | undefined;
    for (let page = 0; route && page < maxPages; page++) {
      const result = await this.#get(route, cwd, signal);
      if (!Array.isArray(result.data)) fail("GH_INVALID_RESPONSE", address.source);
      for (const item of result.data) {
        const data = object(item, address.source);
        const path = string(data.filename, address.source);
        if (createHash("sha256").update(path).digest("hex") === match[1]) {
          if (file) fail("GH_IDENTITY_MISMATCH", address.source);
          file = data;
        }
      }
      route = await this.#next(address, route, result.next, cwd, signal);
      if (file) break;
    }
    if (!file) fail(route ? "GH_DIFF_LOOKUP_INCOMPLETE" : "GH_NOT_FOUND", address.source);
    const path = string(file.filename, address.source);
    if (typeof file.patch !== "string") fail("GH_PATCH_UNAVAILABLE", address.source);
    const side = match.at(2) ?? "R";
    const from = match[3] ? positive(match[3], address.source) : undefined;
    const to = match[5] ? positive(match[5], address.source) : from;
    if (match[4] && match[4] !== side) fail("GH_UNSUPPORTED_FRAGMENT", address.source);
    if (from !== undefined && to !== undefined) {
      if (to < from || to - from > 10000) fail("GH_LINE_OUT_OF_RANGE", address.source);
      const seen = new Set<number>();
      let left: number | undefined, right: number | undefined;
      for (const line of file.patch.split("\n")) {
        const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) {
          left = Number(hunk[1]);
          right = Number(hunk[2]);
          continue;
        }
        if (left === undefined || right === undefined) continue;
        if (!/^[ +-]/.test(line)) continue;
        if (side === "L" && !line.startsWith("+")) seen.add(left);
        if (side === "R" && !line.startsWith("-")) seen.add(right);
        if (!line.startsWith("+")) left++;
        if (!line.startsWith("-")) right++;
      }
      for (let line = from; line <= to; line++)
        if (!seen.has(line)) fail("GH_LINE_NOT_IN_PATCH", address.source);
    }
    const head = commitSha(object(pull.head, address.source).sha, address.source);
    let ref = head;
    if (side === "L") {
      const base = commitSha(object(pull.base, address.source).sha, address.source);
      const comparison = object(
        (await this.#get(`${address.route}/compare/${base}...${head}`, cwd, signal)).data,
        address.source,
      );
      if (
        object(comparison.base_commit, address.source).sha !== base ||
        object(comparison.head_commit, address.source).sha !== head
      )
        fail("GH_IDENTITY_MISMATCH", address.source);
      ref = commitSha(object(comparison.merge_base_commit, address.source).sha, address.source);
    }
    const exactPath =
      side === "L" && typeof file.previous_filename === "string" ? file.previous_filename : path;
    return {
      source: address.source,
      content: [
        "# GitHub PR file diff",
        `Resource: ${address.source}`,
        `Path: ${path}`,
        `Side: ${side}`,
        ...(from ? [`Lines: ${from}-${to}`] : []),
        `Exact file: ${fileLink(address, ref, exactPath)}`,
        "Patch coverage: the API patch may be truncated; only displayed hunk lines were verified.",
        "",
        file.patch,
      ].join("\n"),
    };
  }
}

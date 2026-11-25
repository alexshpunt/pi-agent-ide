import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGithubProvider } from "#github/index.ts";
import { GithubBackend } from "#github/backend.ts";
import { GithubClient } from "#github/client.ts";
import { isolatedCoordinator } from "./github-coordinator.ts";

export const contextHead = "a".repeat(40);
export const contextBase = "b".repeat(40);
export const contextArchive = [80, 75, 3, 4, 255, 0, 7];
const token = "private-context-fixture-token";
const api = "https://api.github.com/repos/example/project";
const browser = "https://github.com/example/project";
const project = { id: "PVT_2", number: 2, title: "Delivery", url: "https://github.com/orgs/example/projects/2", closed: false, shortDescription: "Context fixture" };
const fileText = "first line\nselected-file-marker\noutside-file-marker\n";
const file = (name: string, text = fileText) => ({
  type: "file", path: name, encoding: "base64", content: Buffer.from(text).toString("base64"), size: Buffer.byteLength(text),
  sha: createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex"),
});
const run = { id: 7, name: "Build", status: "completed", conclusion: "failure", head_sha: contextHead, html_url: `${browser}/actions/runs/7`, repository: { full_name: "example/project" }, pull_requests: [{ number: 12 }] };
const job = { id: 8, run_id: 7, name: "Compile", status: "completed", conclusion: "failure", html_url: `${browser}/actions/runs/7/job/8`, steps: [{ number: 1, name: "Setup", status: "completed", conclusion: "success" }, { number: 2, name: "Compile", status: "completed", conclusion: "failure" }] };
const artifact = { id: 9, name: "failure-proof", size_in_bytes: contextArchive.length, expired: false };

/** Observable requests and shared-tool outcomes from the controlled context fixture. */
export interface ContextFixtureState {
  requests: { method: string; host: string; path: string; query: string; authenticated: boolean; body?: Record<string, unknown> }[];
  calls: { label: string; name: string; args: Record<string, unknown>; isError: boolean; result: AgentToolResult<unknown> }[];
}
export const initialContextState = (): ContextFixtureState => ({ requests: [], calls: [] });
const statePath = (cwd: string) => path.join(cwd, "context-fixture.json");
const load = async (cwd: string): Promise<ContextFixtureState> => JSON.parse(await readFile(statePath(cwd), "utf8"));
const save = (cwd: string, value: ContextFixtureState) => writeFile(statePath(cwd), JSON.stringify(value));
const rendered = (result: AgentToolResult<unknown>) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const link = (result: AgentToolResult<unknown>, label: string): string => {
  const line = rendered(result).split("\n").find((value) => value.startsWith(label + ": "));
  if (!line) throw new Error(`Missing navigation link: ${label}`);
  return line.slice(label.length + 2).replace(/^<|>$/gu, "");
};

/** Load the production provider with a bounded, App-authenticated fake HTTP boundary. */
export default async function contextFixture(pi: ExtensionAPI): Promise<void> {
  let cwd = process.cwd();
  pi.on("session_start", (_event, context) => { cwd = context.cwd; });
  const client = new GithubClient({
    async initialize() {},
    async getToken() { return { token, expiresAt: Date.now() + 3_600_000 }; },
    identity: { login: "context-app[bot]", name: "context-app[bot]", email: "context@app.invalid" },
  }, { coordinator: isolatedCoordinator(), fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const authenticated = headers.get("authorization") === `Bearer ${token}`;
    if (url.origin === "https://api.github.com" && !authenticated) throw new Error("Missing App authorization");
    if (!["https://api.github.com", "https://objects.githubusercontent.com"].includes(url.origin)) throw new Error("Unexpected external host");
    if (url.origin !== "https://api.github.com" && headers.has("authorization")) throw new Error("Download received App credentials");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    if (method !== "GET" && !(method === "POST" && url.pathname === "/graphql" && !/\bmutation\b/u.test(String(body?.query)))) throw new Error("Context Read attempted a mutation");
    const state = await load(cwd);
    state.requests.push({ method, host: url.host, path: url.pathname, query: url.search, authenticated, ...(body ? { body } : {}) });
    await save(cwd, state);
    const route = url.pathname.replace(/^\/repos\/example\/project/u, "");
    if (url.host === "objects.githubusercontent.com") return new Response(Uint8Array.from(contextArchive), { headers: { "content-type": "application/zip" } });
    if (url.pathname === "/graphql") {
      const query = String(body?.query);
      const connection = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
      const fields = connection([{ __typename: "ProjectV2SingleSelectField", id: "PVTF_STATUS", name: "Status", options: [{ id: "OPTION_TODO", name: "Todo" }] }]);
      const items = connection([{ id: "PVTI_3", type: "ISSUE", content: { __typename: "Issue", number: 3, title: "Cross-repository issue", url: "https://github.com/other/repo/issues/3", repository: { nameWithOwner: "other/repo" } }, fieldValues: connection([{ __typename: "ProjectV2ItemFieldSingleSelectValue", name: "Todo", field: { name: "Status" } }]) }]);
      return Response.json({ data: { owner: { login: "example", projectV2: { ...project, ...(query.includes("fields(first:") ? { fields } : {}), ...(query.includes("items(first:") ? { items } : {}) } } } });
    }
    if (url.pathname === "/repos/other/repo/issues/3") return Response.json({ number: 3, title: "Cross-repository issue", body: "Linked Project issue body", html_url: "https://github.com/other/repo/issues/3", state: "open" });
    if (route === "/pulls/12") return Response.json({ number: 12, html_url: `${browser}/pull/12`, head: { sha: contextHead }, base: { sha: contextBase } });
    if (route === "/actions/runs") return Response.json({ total_count: 1, workflow_runs: [run] });
    if (route === "/actions/runs/7") return Response.json(run);
    if (route === "/actions/runs/7/jobs") return Response.json({ total_count: 1, jobs: [job] });
    if (route === "/actions/jobs/8") return Response.json(job);
    if (route === "/actions/jobs/8/logs") return new Response("Setup succeeded\nCompile: compile-failure-marker\n", { headers: { "content-type": "text/plain" } });
    if (route === "/actions/runs/7/artifacts") return Response.json({ total_count: 1, artifacts: [artifact] });
    if (route === "/actions/artifacts/9") return Response.json(artifact);
    if (route === "/actions/artifacts/9/zip") return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/fixture/context.zip?signature=fixture-signature" } });
    if (route === "/actions/runs/99") return Response.json({ ...run, id: 99, html_url: "https://github.com/wrong/repo/actions/runs/99" });
    const commitRef = route.startsWith("/commits/") ? decodeURIComponent(route.slice("/commits/".length)) : undefined;
    if (commitRef && [contextHead, "feature/context", "ambiguous", "ambiguous/src"].includes(commitRef)) {
      const value = commitRef === "ambiguous/src" ? contextBase : contextHead;
      return Response.json({ sha: value, html_url: `${browser}/commit/${value}`, commit: { message: "Fixture commit" }, parents: [{ sha: contextBase }], files: [{ filename: "src/a.ts", status: "modified" }] });
    }
    if (route === `/compare/${contextBase}...${contextHead}`) return Response.json({ status: "ahead", ahead_by: 1, behind_by: 0, total_commits: 1, head_commit: { sha: contextHead }, base_commit: { sha: contextBase }, merge_base_commit: { sha: contextBase }, files: [{ filename: "src/a.ts", status: "modified" }] });
    if (route === "/contents/src" && url.searchParams.get("ref") === contextHead) return Response.json([{ type: "file", path: "src/a.ts" }]);
    if (route === "/contents/src/a.ts" && url.searchParams.get("ref") === contextHead) return Response.json(file("src/a.ts"));
    if (route === "/contents/a.ts" && url.searchParams.get("ref") === contextBase) return Response.json(file("a.ts", "different ref\n"));
    return Response.json({ message: "Fixture resource not found" }, { status: 404 });
  }) as typeof fetch });
  await registerGithubProvider(pi, new GithubBackend(async () => client));

  pi.registerTool({
    name: "verify_context_navigation",
    label: "Verify context navigation",
    description: "Test-only chain of real shared Read and Search over context resources.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, context) {
      const invoke = async (label: string, name: string, args: Record<string, unknown>) => {
        const outcome = await context.executeTool(name, args, { signal });
        const state = await load(context.cwd);
        state.calls.push({ label, name, args, isError: !!outcome.isError, result: outcome.result });
        await save(context.cwd, state);
        return outcome;
      };
      const read = async (label: string, source: string, options: Record<string, unknown> = {}) => {
        const outcome = await invoke(label, "read", { path: source, ...options });
        if (outcome.isError) throw new Error(`${label}: ${rendered(outcome.result)}`);
        return outcome.result;
      };
      const search = async (label: string, source: string, query: string) => {
        const outcome = await invoke(label, "search", { path: source, query });
        if (outcome.isError) throw new Error(`${label}: ${rendered(outcome.result)}`);
        return outcome.result;
      };
      const checks = await read("checks", `${browser}/pull/12/checks`);
      if ((await load(context.cwd)).requests.length !== 1) throw new Error("PR context eagerly read linked CI resources");
      const runs = await read("runs", link(checks, "Workflow runs"));
      const workflow = await read("run", link(runs, "Read"));
      const jobs = await read("jobs", link(workflow, "Jobs"));
      const details = await read("job", link(jobs, "Read"));
      await read("job-browser", `${browser}/actions/runs/7/job/8`);
      await read("log", link(details, "Logs"));
      const artifacts = await read("artifacts", link(workflow, "Artifacts"));
      const meta = await read("artifact", link(artifacts, "Read"));
      const archiveSource = link(meta, "Original archive");
      await read("archive", archiveSource);
      await read("archive-window", "raw:" + archiveSource, { offset: 2, limit: 3 });

      const projectCard = await read("project", project.url);
      if ((await load(context.cwd)).requests.some((request) => request.path === "/repos/other/repo/issues/3")) throw new Error("Project card eagerly fetched linked issue text");
      await read("project-fields", link(projectCard, "Fields"));
      const items = await read("project-items", link(projectCard, "Items"));
      const issueCard = await read("project-issue", link(items, "Content"));
      await read("project-issue-body", link(issueCard, "Editable body"));

      const tree = await read("tree", `${browser}/tree/feature/context/src`);
      const exactFile = /github:\/\/example\/project\/file\?[^\s]+/u.exec(rendered(tree))?.[0];
      if (!exactFile) throw new Error("Verified tree lost its exact file link");
      await read("exact-file", exactFile);
      await read("blob-lines", `${browser}/blob/feature/context/src/a.ts#L2`);
      const selected = await read("selected-file", exactFile, { offset: 2, limit: 1, views: ["anchors"] });
      const found = await search("selected-search", rendered(selected), "selected-file-marker");
      if (!rendered(found).includes("RESULT#")) throw new Error("File selection search lost its reusable match");
      await read("selected-match", rendered(found));
      await search("outside-search", rendered(selected), "outside-file-marker");
      await read("commit", `${browser}/commit/${contextHead}`);
      await read("compare", `${browser}/compare/${contextBase}...${contextHead}`);
      for (const [label, source, reason] of [
        ["wrong-owner", `${browser}/actions/runs/99`, "GH_IDENTITY_MISMATCH"],
        ["ambiguous-file", `${browser}/blob/ambiguous/src/a.ts`, "GH_AMBIGUOUS_REF"],
      ]) {
        const outcome = await invoke(label!, "read", { path: source });
        if (!outcome.isError || !rendered(outcome.result).includes(reason!)) throw new Error(`${label} did not fail safely`);
      }
      return { content: [{ type: "text", text: "Context navigation stayed readonly and scoped." }], details: { file: statePath(context.cwd) } };
    },
  });
}

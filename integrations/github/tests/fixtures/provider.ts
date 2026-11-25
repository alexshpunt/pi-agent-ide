import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { registerGithubProvider } from "#github/index.ts";
import { GithubBackend } from "#github/backend.ts";
import { GithubClient } from "#github/client.ts";
import { isolatedCoordinator } from "./github-coordinator.ts";

const bodySource = "github://example/project/issues/12#body";
const token = "private-fixture-token";

interface FixtureIssue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: string;
  updated_at: string;
  html_url: string;
  repository_url: string;
  labels: string[];
  assignees: string[];
  milestone: null;
}
interface FixtureComment {
  id: number;
  body: string;
  updated_at: string;
  html_url: string;
  issue_url: string;
}
interface FixtureRequest {
  method: string;
  path: string;
  query: string;
  body?: Record<string, unknown>;
}
interface FixtureState {
  issues: Record<string, FixtureIssue>;
  comments: FixtureComment[];
  requests: FixtureRequest[];
  sequence: number;
}
const fileFor = (cwd: string) => path.join(cwd, "github-fixture.json");
const load = async (cwd: string): Promise<FixtureState> => JSON.parse(await readFile(fileFor(cwd), "utf8"));
const save = async (cwd: string, state: FixtureState) => writeFile(fileFor(cwd), JSON.stringify(state, null, 2));
const rendered = (result: AgentToolResult<unknown>) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");

export default async function fixture(pi: ExtensionAPI): Promise<void> {
  let cwd = process.cwd();
  pi.on("session_start", (_event, context) => { cwd = context.cwd; });
  const client = new GithubClient({
    async initialize() {},
    async getToken() { return { token, expiresAt: Date.now() + 3_600_000 }; },
    identity: { login: "fixture-app[bot]", name: "fixture-app[bot]", email: "fixture@app.invalid" },
  }, {
    coordinator: isolatedCoordinator(),
    fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== "https://api.github.com") throw new Error("Fixture blocked an external host");
      if (new Headers(init?.headers).get("authorization") !== "Bearer " + token) throw new Error("Missing fixture App authentication");
      const state = await load(cwd);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      state.requests.push({ method, path: url.pathname, query: url.search, ...(body ? { body } : {}) });
      const reply = async (data: unknown, status = 200) => {
        await save(cwd, state);
        return Response.json(data, { status });
      };
      if (method === "GET" && url.pathname === "/search/issues") {
        return reply({ total_count: 1, incomplete_results: false, items: [state.issues["12"]] });
      }
      const issue = /^\/repos\/example\/project\/issues\/(\d+)$/.exec(url.pathname);
      if (issue?.[1] === "403" && method === "GET") return reply({ message: token }, 403);
      if (issue && method === "GET") return reply(state.issues[issue[1]] ?? { message: token }, state.issues[issue[1]] ? 200 : 404);
      if (issue && method === "PATCH" && state.issues[issue[1]]) {
        state.issues[issue[1]] = { ...state.issues[issue[1]], ...body, updated_at: "revision-" + ++state.sequence };
        return reply(state.issues[issue[1]]);
      }
      if (url.pathname === "/repos/example/project/issues" && method === "POST" && body) {
        const number = 99 + Object.keys(state.issues).length - 1;
        const created: FixtureIssue = {
          number, id: number, title: String(body.title), body: String(body.body ?? ""), state: "open",
          updated_at: "revision-" + ++state.sequence,
          html_url: "https://github.com/example/project/issues/" + number,
          repository_url: "https://api.github.com/repos/example/project",
          labels: [], assignees: [], milestone: null,
        };
        state.issues[String(number)] = created;
        if (body.title === "simulate-unknown") {
          await save(cwd, state);
          throw new Error(token);
        }
        return reply(created, 201);
      }
      if (url.pathname === "/repos/example/project/issues/12/comments" && method === "POST" && body) {
        const comment: FixtureComment = {
          id: 34 + state.comments.length, body: String(body.body), updated_at: "revision-" + ++state.sequence,
          html_url: "https://github.com/example/project/issues/12#issuecomment-" + (34 + state.comments.length),
          issue_url: "https://api.github.com/repos/example/project/issues/12",
        };
        state.comments.push(comment);
        return reply(comment, 201);
      }
      const comment = /^\/repos\/example\/project\/issues\/comments\/(\d+)$/.exec(url.pathname);
      if (comment && method === "GET") {
        const value = state.comments.find((item) => item.id === Number(comment[1]));
        return reply(value ?? { message: token }, value ? 200 : 404);
      }
      return reply({ message: token }, 404);
    }) as typeof fetch,
  });
  await registerGithubProvider(pi, new GithubBackend(async () => client));

  pi.registerTool({
    name: "verify_github_scope",
    label: "Verify GitHub scope",
    description: "Test-only probe for exact Read/Search selections and stale remote writes.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, context) {
      const standalone = pi.getAllTools().some(tool => tool.name === "github_read" && tool.exposure !== "hidden");
      const invoke = (name: string, args: Record<string, unknown>) => context.executeTool(standalone ? "github_" + name : name, args, { signal });
      const checked = async (name: string, args: Record<string, unknown>) => {
        const result = await invoke(name, args);
        if (result.isError) throw new Error(name + " failed: " + rendered(result.result));
        return result.result;
      };
      const selected = await checked("read", { path: bodySource, offset: 1, limit: 1, views: ["anchors"] });
      const expanded = await checked("read", { path: rendered(selected), limit: 100 });
      const outside = await checked("search", { path: rendered(expanded), query: "Last line" });
      if (!rendered(outside).includes("0 matches")) throw new Error("Read widened its selected line");
      await checked("replace", { path: rendered(expanded), text: "Scoped\n" });
      let state = await load(context.cwd);
      if (state.issues["12"].body !== "Scoped\nLast line\n") throw new Error("Read selection changed unselected body text");
      const searched = await checked("search", { path: bodySource, query: "Scoped" });
      const match = /<(RESULT#[a-f0-9-]+)>/iu.exec(rendered(searched))?.[1];
      if (!match) throw new Error("Search did not expose its exact-match selector");
      await checked("replace", { path: match, text: "Searched" });
      state = await load(context.cwd);
      if (state.issues["12"].body !== "Searched\nLast line\n") throw new Error("Search selection changed unselected body text");
      const stale = await checked("read", { path: bodySource, offset: 1, limit: 1 });
      state.issues["12"].body = "External change\nLast line\n";
      state.issues["12"].updated_at = "external-" + ++state.sequence;
      const mutationsBefore = state.requests.filter((request) => request.method === "PATCH").length;
      await save(context.cwd, state);
      const rejected = await invoke("replace", { path: rendered(stale), text: "Wrong" });
      const after = await load(context.cwd);
      if (!rejected.isError || after.issues["12"].body !== "External change\nLast line\n" || after.requests.filter((request) => request.method === "PATCH").length !== mutationsBefore) {
        throw new Error("Stale result dispatched a remote write");
      }
      return {
        content: [{ type: "text", text: "Exact Read/Search ranges edited; stale source rejected without PATCH." }],
        details: { source: bodySource },
      };
    },
  });
}

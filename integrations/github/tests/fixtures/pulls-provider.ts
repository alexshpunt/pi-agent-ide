import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGithubProvider } from "#github/index.ts";
import { GithubBackend } from "#github/backend.ts";
import { GithubClient } from "#github/client.ts";
import { isolatedCoordinator } from "./github-coordinator.ts";

export const headSha = "a".repeat(40);
export const filePath = "src/a b.ts";
export const fileText = "export const answer = 42;\n";
export const patch = "@@ -1 +1 @@\n-export const answer = 41;\n+export const answer = 42;";
const token = "private-pulls-fixture-token";
const pullUrl = "https://github.com/example/project/pull/12";

/** Local HTTP-boundary state, persisted so tests can check dispatched requests and saved effects. */
export interface PullsState {
  pulls: Record<string, Record<string, unknown>>;
  conversation: Record<string, unknown>[];
  inline: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  requests: { method: string; path: string; query: string; body?: Record<string, unknown> }[];
  sequence: number;
}

/** Seed one real-looking PR without making a remote request. */
export function initialPullsState(): PullsState {
  return {
    pulls: {
      "12": {
        id: 120,
        number: 12,
        title: "Fixture PR",
        body: "Original PR body\n",
        state: "open",
        draft: true,
        maintainer_can_modify: true,
        head: { ref: "feature", sha: headSha },
        base: { ref: "develop" },
        updated_at: "revision-0",
        html_url: pullUrl,
      },
    },
    conversation: [],
    inline: [],
    reviews: [],
    requests: [],
    sequence: 0,
  };
}

export default async function fixture(pi: ExtensionAPI): Promise<void> {
  let cwd = process.cwd();
  pi.on("session_start", (_event, context) => {
    cwd = context.cwd;
  });
  const stateFile = () => path.join(cwd, "pulls-fixture.json");
  const client = new GithubClient(
    {
      async initialize() {},
      async getToken() {
        return { token, expiresAt: Date.now() + 3_600_000 };
      },
      identity: {
        login: "fixture-app[bot]",
        name: "fixture-app[bot]",
        email: "fixture@app.invalid",
      },
    },
    {
      coordinator: isolatedCoordinator(),
      fetcher: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.origin !== "https://api.github.com")
          throw new Error("Fixture blocked an external host");
        if (new Headers(init?.headers).get("authorization") !== "Bearer " + token)
          throw new Error("Missing fixture App authentication");
        const state: PullsState = JSON.parse(await readFile(stateFile(), "utf8"));
        const method = init?.method ?? "GET";
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Record<string, unknown>)
            : undefined;
        state.requests.push({
          method,
          path: url.pathname,
          query: url.search,
          ...(body ? { body } : {}),
        });
        const reply = async (data: unknown, status = 200) => {
          await writeFile(stateFile(), JSON.stringify(state, null, 2));
          return Response.json(data, { status });
        };
        const revision = () => "revision-" + ++state.sequence;
        const pull = /^\/repos\/example\/project\/pulls\/(\d+)$/.exec(url.pathname);
        if (pull && method === "GET")
          return reply(
            state.pulls[pull[1]] ?? { message: token },
            state.pulls[pull[1]] ? 200 : 404,
          );
        if (pull && method === "PATCH" && state.pulls[pull[1]]) {
          state.pulls[pull[1]] = { ...state.pulls[pull[1]], ...body, updated_at: revision() };
          if (typeof body?.base === "string") state.pulls[pull[1]].base = { ref: body.base };
          return reply(state.pulls[pull[1]]);
        }
        if (url.pathname === "/repos/example/project/pulls" && method === "POST" && body) {
          state.pulls["12"] = {
            ...initialPullsState().pulls["12"],
            ...body,
            base: { ref: body.base },
            head: { ref: body.head, sha: headSha },
            updated_at: revision(),
          };
          return reply(state.pulls["12"], 201);
        }
        if (url.pathname === "/repos/example/project/issues/12/comments") {
          if (method === "GET") return reply(state.conversation);
          if (method === "POST" && body) {
            const comment = {
              id: 101,
              ...body,
              updated_at: revision(),
              html_url: pullUrl + "#issuecomment-101",
            };
            state.conversation.push(comment);
            return reply(comment, 201);
          }
        }
        const ordinary = /^\/repos\/example\/project\/issues\/comments\/(\d+)$/.exec(url.pathname);
        if (ordinary && method === "GET") {
          const comment = state.conversation.find((item) => item.id === Number(ordinary[1]));
          return reply(comment ?? { message: token }, comment ? 200 : 404);
        }
        if (url.pathname === "/repos/example/project/pulls/12/comments" && method === "GET")
          return reply(state.inline);
        const inlineCreate = url.pathname === "/repos/example/project/pulls/12/comments";
        const inlineReply = url.pathname === "/repos/example/project/pulls/12/comments/201/replies";
        if ((inlineCreate || inlineReply) && method === "POST" && body) {
          const id = inlineReply ? 202 : 201;
          const comment = {
            id,
            ...body,
            updated_at: revision(),
            html_url: pullUrl + "#discussion_r" + id,
            pull_request_url: "https://api.github.com/repos/example/project/pulls/12",
            ...(inlineReply ? { in_reply_to_id: 201 } : {}),
          };
          state.inline.push(comment);
          return reply(comment, 201);
        }
        const inline = /^\/repos\/example\/project\/pulls\/comments\/(\d+)$/.exec(url.pathname);
        if (inline && method === "GET") {
          const comment = state.inline.find((item) => item.id === Number(inline[1]));
          return reply(comment ?? { message: token }, comment ? 200 : 404);
        }
        if (url.pathname === "/repos/example/project/pulls/12/reviews") {
          if (method === "GET") return reply(state.reviews);
          if (method === "POST" && body) {
            const review = {
              id: 301,
              ...body,
              state: "PENDING",
              updated_at: revision(),
              html_url: pullUrl + "#pullrequestreview-301",
            };
            state.reviews.push(review);
            return reply(review, 201);
          }
        }
        if (url.pathname === "/repos/example/project/pulls/12/reviews/301" && method === "GET")
          return reply(state.reviews.find((item) => item.id === 301));
        if (url.pathname === "/repos/example/project/pulls/12/files" && method === "GET")
          return reply([
            {
              filename: filePath,
              status: "modified",
              additions: 1,
              deletions: 1,
              changes: 2,
              sha: "b".repeat(40),
              patch,
            },
          ]);
        if (
          url.pathname === "/repos/example/project/contents/src/a%20b.ts" &&
          method === "GET" &&
          url.searchParams.get("ref") === headSha
        )
          return reply({
            type: "file",
            encoding: "base64",
            path: filePath,
            content: Buffer.from(fileText).toString("base64"),
          });
        return reply({ message: token }, 404);
      }) as typeof fetch,
    },
  );
  await registerGithubProvider(pi, new GithubBackend(async () => client));

  let response = 0;
  pi.registerProvider("pulls-fixture", {
    name: "Local headless PR fixture",
    baseUrl: "https://pulls-fixture.invalid",
    apiKey: "fixture",
    api: "openai-completions",
    models: [
      {
        id: "headless",
        name: "Headless PR fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model) {
      const first = response++ === 0;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: first
          ? [
              {
                type: "toolCall",
                id: "headless-probe",
                name: "verify_pull_headless",
                arguments: {},
              },
            ]
          : [{ type: "text", text: "Headless PR fixture finished." }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: first ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });

  pi.registerTool({
    name: "verify_pull_headless",
    label: "Verify headless PR actions",
    description: "Test-only probe for real headless shared Write approval hooks.",
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, context) {
      if (context.hasUI) throw new Error("Probe requires a genuinely headless Pi context");
      const cases = [
        [
          "github://example/project/pulls/12/reviews/301/submit",
          { event: "APPROVE", body: "Submit review" },
        ],
        ["github://example/project/pulls/12/merge", { sha: headSha, merge_method: "squash" }],
        [
          "github://example/project/pulls/12/reviews/new",
          { event: "APPROVE", commit_id: headSha, body: "Immediate approval" },
        ],
      ] as const;
      const calls = [];
      for (const [source, body] of cases) {
        const standalone = pi.getAllTools().some(tool => tool.name === "github_write" && tool.exposure !== "hidden");
        const outcome = await context.executeTool(
          standalone ? "github_write" : "write",
          { path: source, content: JSON.stringify(body) },
          { signal },
        );
        calls.push({ source, isError: outcome.isError, result: outcome.result });
      }
      return {
        content: [{ type: "text", text: "Headless shared Write approval results captured." }],
        details: { hasUI: context.hasUI, mode: context.mode, calls },
      };
    },
  });
}

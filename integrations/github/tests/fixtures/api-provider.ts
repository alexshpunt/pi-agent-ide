import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGithubProvider } from "#github/index.ts";
import { GithubBackend } from "#github/backend.ts";
import { GithubClient } from "#github/client.ts";
import { isolatedCoordinator } from "./github-coordinator.ts";
import { connectReadPlugin, READ_API_VERSION, READ_PROTOCOL } from "pi-agent-ide/api/read";

const token = "private-open-api-fixture-token";
export const widgetSource = "https://api.github.com/repos/example/project/widgets/17";
export const widgetsSource = "https://api.github.com/repos/example/project/widgets?state=active&per_page=1";
export const archive = [80, 75, 3, 4, 255, 0, 7];

/** HTTP effects from a deterministic fixture, not requests to a remote GitHub installation. */
export interface ApiFixtureState {
  value: string;
  deleted: boolean;
  requests: { method: string; host: string; path: string; query: string; authenticated: boolean; body?: Record<string, unknown> }[];
}
export function initialApiState(): ApiFixtureState {
  return { value: "Original API value", deleted: false, requests: [] };
}
const fileFor = (cwd: string) => path.join(cwd, "api-fixture.json");
const load = async (cwd: string): Promise<ApiFixtureState> => JSON.parse(await readFile(fileFor(cwd), "utf8"));
const save = (cwd: string, state: ApiFixtureState) => writeFile(fileFor(cwd), JSON.stringify(state, null, 2));
const rendered = (result: AgentToolResult<unknown>) => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const responseSource = (result: AgentToolResult<unknown>) => {
  const source = /github:\/\/api\/results\/[a-f0-9-]{36}/u.exec(rendered(result))?.[0];
  if (!source) throw new Error("Shared Write did not return a response resource");
  return source;
};

/** Register the production provider against a controlled, authenticated HTTP boundary. */
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
      const headers = new Headers(init?.headers);
      const authenticated = headers.get("authorization") === "Bearer " + token;
      if (url.origin === "https://api.github.com" && !authenticated) throw new Error("Missing App identity");
      if (url.origin === "https://objects.githubusercontent.com" && headers.has("authorization")) throw new Error("App credential reached the download host");
      if (!["https://api.github.com", "https://objects.githubusercontent.com"].includes(url.origin)) throw new Error("Fixture blocked an external host");
      const state = await load(cwd);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      state.requests.push({ method, host: url.host, path: url.pathname, query: url.search, authenticated, ...(body ? { body } : {}) });
      const reply = async (data: unknown, status = 200, extra: HeadersInit = {}) => {
        await save(cwd, state);
        return Response.json(data, { status, headers: extra });
      };
      const widget = () => ({ id: 17, value: state.value, detail: "outside-selected-marker", url: widgetSource, related_url: "https://api.github.com/repos/example/project/widgets/18" });
      if (url.host === "objects.githubusercontent.com") {
        await save(cwd, state);
        return new Response(Uint8Array.from(archive), { headers: { "content-type": "application/zip" } });
      }
      if (method === "GET" && url.pathname === "/repos/example/project/widgets") {
        if (url.searchParams.get("page") === "2") return reply([{ id: 18, value: "Second page" }]);
        return reply([widget()], 200, { link: `<${widgetsSource}&page=2>; rel="next"` });
      }
      if (method === "GET" && url.pathname === "/repos/example/project/widgets/17") return reply(widget());
      if (method === "PATCH" && url.pathname === "/repos/example/project/widgets/17") {
        state.value = String(body?.value);
        return reply(widget());
      }
      if (method === "DELETE" && url.pathname === "/repos/example/project/widgets/18") {
        state.deleted = true;
        await save(cwd, state);
        return new Response(null, { status: 204 });
      }
      if (method === "POST" && url.pathname === "/repos/example/project/widgets/unknown") {
        state.value = "Mutation saved before the connection failed";
        await save(cwd, state);
        throw new Error(token);
      }
      if (method === "GET" && url.pathname === "/repos/example/project/text-preview") {
        await save(cwd, state);
        return new Response("Readable non-JSON response\n", { headers: { "content-type": "text/plain" } });
      }
      if (method === "GET" && url.pathname === "/repos/example/project/actions/artifacts/17/zip") {
        await save(cwd, state);
        return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/fixture/archive.zip?signature=fixture-only" } });
      }
      if (method === "POST" && url.pathname === "/graphql") {
        const variables = body?.variables as Record<string, unknown> | undefined;
        const query = String(body?.query);
        if (/\bmutation\b/u.test(query)) {
          state.value = String(variables?.value ?? "GraphQL value");
          if (query.includes("Partial")) return reply({ data: { changed: true }, errors: [{ message: "Partial mutation failed" }] });
          return reply({ data: { updateWidget: { id: "WIDGET_17", value: state.value } } });
        }
        return reply({ data: { node: { id: variables?.id, value: state.value }, operation: body?.operationName } });
      }
      return reply({ message: token }, 404);
    }) as typeof fetch,
  });
  await registerGithubProvider(pi, new GithubBackend(async () => client));

  // Keep pipeline evidence when a nested shared-tool failure stops the outer probe.
  const readEvidence: Record<string, unknown>[] = [];
  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "github-api-fixture-evidence",
    setup(api) {
      api.addHandler({
        stage: "post-read",
        async handler(context) {
          const state = context.state;
          if (state?.resolvedBy === "github-api") {
            readEvidence.push({
              source: state.source,
              contentKind: state.contentKind,
              sourceTextPresent: context.sourceText !== undefined,
              sourceTextMatches: state.contentKind === "text" && context.sourceText === state.text.content,
              hasInputSelection: context.sourceTarget !== undefined,
            });
            await writeFile(path.join(cwd, "read-selection-evidence.json"), JSON.stringify(readEvidence, null, 2));
          }
          return { kind: "continue", context };
        },
      });
    },
  });

  pi.registerTool({
    name: "verify_open_api",
    label: "Verify open API resources",
    description: "Test-only probe for shared raw Write, response resources and exact Read/Search scopes.",
    parameters: Type.Object({ headless: Type.Optional(Type.Boolean()) }),
    async execute(_id, args, signal, _update, context) {
      if (args.headless && context.hasUI) throw new Error("Headless probe received a UI binding");
      const calls: { name: string; args: Record<string, unknown>; isError: boolean; result: AgentToolResult<unknown> }[] = [];
      const invoke = async (name: string, input: Record<string, unknown>) => {
        const standalone = pi.getAllTools().some(tool => tool.name === "github_read" && tool.exposure !== "hidden");
        const outcome = await context.executeTool(standalone ? "github_" + name : name, input, { signal });
        calls.push({ name, args: input, isError: !!outcome.isError, result: outcome.result });
        await writeFile(path.join(cwd, "nested-tool-evidence.json"), JSON.stringify(calls, null, 2));
        return outcome;
      };
      const checked = async (name: string, input: Record<string, unknown>) => {
        const outcome = await invoke(name, input);
        if (outcome.isError) throw new Error(name + " failed: " + rendered(outcome.result));
        return outcome.result;
      };
      const selected = await checked("read", { path: widgetSource, offset: 1, limit: 1, views: ["anchors"] });
      const expanded = await checked("read", { path: rendered(selected), limit: 100 });
      const outside = await checked("search", { path: rendered(expanded), query: "outside-selected-marker" });
      if (!rendered(outside).includes("0 matches")) throw new Error("Universal Read widened its selected range");
      const complete = await checked("search", { path: widgetSource, query: "outside-selected-marker" });
      if (!rendered(complete).includes("RESULT#")) throw new Error("API Search did not expose a reusable exact selection");
      await checked("read", { path: rendered(complete) });
      const collection = await checked("read", { path: widgetsSource });
      const next = /Next page: <([^>]+)>/u.exec(rendered(collection))?.[1];
      if (!next) throw new Error("API collection lost its exact continuation link");
      const page = await checked("read", { path: next });
      if (!rendered(page).includes("Second page")) throw new Error("API pagination did not retain the collection scope");

      const patched = await checked("write", { path: "github://api/rest", content: JSON.stringify({ method: "PATCH", path: "/repos/example/project/widgets/17", body: { value: "REST changed" } }) });
      const restResponse = responseSource(patched);
      const saved = await checked("read", { path: restResponse });
      if (!rendered(saved).includes("REST changed")) throw new Error("Raw Write response was not readable");
      await checked("write", { path: "github://api/rest", content: JSON.stringify({ method: "DELETE", path: "/repos/example/project/widgets/18" }) });
      const query = { query: "query View($id: ID!) { node(id: $id) { id } }", variables: { id: "WIDGET_17" }, operationName: "View" };
      const queried = await checked("write", { path: "github://api/graphql", content: JSON.stringify(query) });
      const queryResponse = responseSource(queried);
      const queryRead = await checked("read", { path: queryResponse });
      if (!rendered(queryRead).includes("WIDGET_17") || !rendered(queryRead).includes("View")) throw new Error("Named GraphQL query lost its variables or operationName");
      await checked("search", { path: queryResponse, query: "WIDGET_17" });
      const mutation = { query: "mutation Change($value: String!) { updateWidget(value: $value) { id } }", variables: { value: "GraphQL changed" }, operationName: "Change" };
      const changed = await checked("write", { path: "github://api/graphql", content: JSON.stringify(mutation) });
      await checked("read", { path: responseSource(changed) });
      const old = await checked("read", { path: restResponse });
      if (!rendered(old).includes("REST changed") || rendered(old).includes("GraphQL changed")) throw new Error("A saved API response was not immutable");
      const text = await checked("read", { path: "https://api.github.com/repos/example/project/text-preview" });
      if (!rendered(text).includes("Readable non-JSON response")) throw new Error("Plain response was treated as invalid JSON");

      const downloaded = await checked("write", { path: "github://api/rest", content: JSON.stringify({ method: "GET", path: "/repos/example/project/actions/artifacts/17/zip" }) });
      const binary = responseSource(downloaded);
      const binaryRead = await checked("read", { path: binary });
      if (!rendered(binaryRead).includes("not extracted")) throw new Error("Archive bytes were presented as extracted text");
      const bytes = await checked("read", { path: "raw:" + binary, offset: 2, limit: 3 });
      if (!rendered(bytes).includes("03 04 ff")) throw new Error("Raw API byte window changed the original bytes");

      const before = (await load(context.cwd)).requests.length;
      for (const input of [
        { method: "GET", path: "https://untrusted.invalid/repos/example/project" },
        { method: "GET", path: "/user?access_token=another-identity" },
        { method: "POST", path: "/repos/example/project/widgets", headers: { Authorization: "another-identity" } },
      ]) {
        const refused = await invoke("write", { path: "github://api/rest", content: JSON.stringify(input) });
        if (!refused.isError) throw new Error("An invalid host or credential override was accepted");
      }
      if ((await load(context.cwd)).requests.length !== before) throw new Error("Invalid raw requests reached HTTP");
      const unknown = await invoke("write", { path: "github://api/rest", content: JSON.stringify({ method: "POST", path: "/repos/example/project/widgets/unknown", body: { value: "saved" } }) });
      if (!unknown.isError || !rendered(unknown.result).includes("GH_REQUEST_FAILED")) throw new Error("Unknown raw mutation appeared successful");
      const partial = await invoke("write", { path: "github://api/graphql", content: JSON.stringify({ query: "mutation Partial { change }", variables: { value: "Partial GraphQL effect" } }) });
      if (!partial.isError || !rendered(partial.result).includes("GH_GRAPHQL_ERROR")) throw new Error("Partial GraphQL errors appeared successful");
      const partialRead = await checked("read", { path: responseSource(partial.result) });
      if (!rendered(partialRead).includes("Partial mutation failed")) throw new Error("Failed GraphQL response was not retained");

      if (args.headless) {
        const beforeTyped = (await load(context.cwd)).requests.length;
        const typed = await invoke("write", { path: "github://example/project/pulls/12/merge", content: JSON.stringify({ sha: "a".repeat(40), merge_method: "squash" }) });
        if (!typed.isError || !rendered(typed.result).includes("GH_APPROVAL_REQUIRED")) throw new Error("Typed merge approval gate was bypassed");
        if ((await load(context.cwd)).requests.length !== beforeTyped) throw new Error("Denied typed merge reached HTTP");
      }
      return { content: [{ type: "text", text: "Shared API resource checks captured." }], details: { hasUI: context.hasUI, mode: context.mode, calls, restResponse, queryResponse, binary } };
    },
  });

  let responses = 0;
  pi.registerProvider("open-api-fixture", {
    name: "Local headless open API fixture",
    baseUrl: "https://open-api-fixture.invalid",
    apiKey: "fixture",
    api: "openai-completions",
    models: [{ id: "headless", name: "Headless API fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
    streamSimple(model) {
      const first = responses++ === 0;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: first ? [{ type: "toolCall", id: "headless-api-probe", name: "verify_open_api", arguments: { headless: true } }] : [{ type: "text", text: "Headless API fixture finished." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
}

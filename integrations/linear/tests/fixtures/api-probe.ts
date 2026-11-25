import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const requestSource = "linear://example/api/graphql";
const marker = "outside-selected-fixture-marker";
const reactionId = "20000000-0000-4000-8000-000000000002";
export const queryRequest = {
  query: "query FixtureQuery($id: String!) { fixture(id: $id) { id value detail } }",
  variables: { id: "FIXTURE_17" }, operationName: "FixtureQuery",
};
export const mutationRequest = {
  query: "mutation FixtureReaction($input: ReactionCreateInput!) { reactionCreate(input: $input) { success reaction { id emoji } } }",
  variables: { input: { id: reactionId, commentId: "10000000-0000-4000-8000-000000000001", emoji: "thumbsup" } },
  operationName: "FixtureReaction",
};
export interface ApiFixtureState {
  value: string;
  reaction?: { id: string; emoji: string };
  requests: { kind: "scope" | "raw"; url: string; authenticated: boolean; body: Record<string, unknown> }[];
  typedMutations: string[];
}
export const initialApiState = (): ApiFixtureState => ({ value: "Original fixture value", requests: [], typedMutations: [] });
export interface ApiProbeDetails {
  hasUI: boolean;
  mode: string;
  calls: { name: string; args: Record<string, unknown>; isError: boolean; result: AgentToolResult<unknown> }[];
  queryResponse: string;
  mutationResponse: string;
  unknownResponse: string;
  partialResponse: string;
}
const rendered = (result: AgentToolResult<unknown>) => result.content
  .filter(block => block.type === "text").map(block => block.text).join("\n");
function action(result: AgentToolResult<unknown>): Record<string, unknown> {
  const value = (result.details as { metadata?: { semanticAction?: unknown } } | undefined)?.metadata?.semanticAction;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing structured API receipt");
  return value as Record<string, unknown>;
}
function responseSource(result: AgentToolResult<unknown>): string {
  const source = action(result).source;
  if (typeof source !== "string" || !/^linear:\/\/example\/api\/results\/[a-f0-9-]{36}$/u.test(source))
    throw new Error("Invalid structured response resource");
  return source;
}

/** Nested calls use the public tool dispatcher, including normal extension hooks and UI policy. */
export default function apiProbe(pi: ExtensionAPI): void {
  let retained: ApiProbeDetails | undefined;
  pi.registerTool({
    name: "verify_linear_raw_api",
    label: "Verify Linear raw API",
    description: "Controlled fixture probe for raw Write, retained Read/Search and typed approval policy.",
    parameters: Type.Object({ headless: Type.Optional(Type.Boolean()) }),
    async execute(_id, args, signal, _update, context) {
      if (args.headless && context.hasUI) throw new Error("Headless probe received a UI binding");
      const calls: ApiProbeDetails["calls"] = [];
      const state = async (): Promise<ApiFixtureState> => JSON.parse(await readFile(path.join(context.cwd, "api-fixture.json"), "utf8"));
      const invoke = async (name: string, input: Record<string, unknown>) => {
        const standalone = pi.getAllTools().some(tool => tool.name === "linear_read" && tool.exposure !== "hidden");
        const outcome = await context.executeTool(standalone ? "linear_" + name : name, input, { signal });
        calls.push({ name, args: input, isError: !!outcome.isError, result: outcome.result });
        await writeFile(path.join(context.cwd, "api-nested-tool-evidence.json"), JSON.stringify(calls, null, 2));
        return outcome;
      };
      const checked = async (name: string, input: Record<string, unknown>) => {
        const outcome = await invoke(name, input);
        if (outcome.isError) throw new Error(name + " failed: " + rendered(outcome.result));
        return outcome.result;
      };
      const queried = await checked("write", { path: requestSource, content: JSON.stringify(queryRequest) });
      const queryAction = action(queried);
      if (queryAction.ok !== true || queryAction.effect !== "not-applied") throw new Error("Read-only query status was changed");
      const queryResponse = responseSource(queried);
      const completeRead = await checked("read", { path: queryResponse });
      if (!rendered(completeRead).includes("FIXTURE_17") || !rendered(completeRead).includes("Original fixture value"))
        throw new Error("Query response lost fixture data");
      if (JSON.stringify(queryAction).includes("Original fixture value")) throw new Error("Write metadata duplicated the response body");
      const beforeSearch = (await state()).requests.length;
      const standalone = pi.getAllTools().some(tool => tool.name === "linear_read" && tool.exposure !== "hidden");
      const selected = await checked("read", { path: queryResponse, offset: 1, limit: 1, views: ["anchors"] });
      if (rendered(selected).includes(marker)) throw new Error("Bounded response Read included an unselected field");
      if (!standalone) {
        const expanded = await checked("read", { path: rendered(selected), limit: 100 });
        if (rendered(expanded).includes(marker)) throw new Error("Read widened the selected response window");
        const outside = await checked("search", { path: rendered(expanded), query: marker });
        const outsidePayload = (outside.details as { payload?: { matches?: unknown[] } } | undefined)?.payload;
        if (outsidePayload?.matches?.length !== 0) throw new Error("Search widened or failed the selected response window");
      }
      const whole = await checked("search", { path: queryResponse, query: marker });
      if (!rendered(whole).includes(marker)) throw new Error("Response Search lost its fixture match");
      if (!standalone) {
        if (!rendered(whole).includes("RESULT#")) throw new Error("Response Search did not return its fixture selection");
        await checked("read", { path: rendered(whole) });
      }
      if ((await state()).requests.length !== beforeSearch) throw new Error("Stored response search reached the API");
      const foreign = await invoke("read", { path: queryResponse.replace("//example/", "//other/") });
      if (!foreign.isError) throw new Error("A response crossed workspace scope");

      const changed = await checked("write", { path: requestSource, content: JSON.stringify(mutationRequest) });
      const mutationResponse = responseSource(changed);
      const mutationRead = await checked("read", { path: mutationResponse });
      if (!rendered(mutationRead).includes(reactionId) || !rendered(mutationRead).includes("thumbsup")) throw new Error("Mutation response lost its saved fixture");
      const immutable = await checked("read", { path: queryResponse });
      if (!rendered(immutable).includes("Original fixture value") || rendered(immutable).includes("Raw mutation fixture"))
        throw new Error("A saved response changed with remote state");

      const beforeInvalid = (await state()).requests.length;
      for (const input of [
        { query: "{ viewer { id } }", endpoint: "https://untrusted.invalid/graphql" },
        { query: "{ viewer { id } }", headers: { authorization: "caller-fixture" } },
        { query: "query One { fixture } query Two { fixture }" },
      ]) {
        const refused = await invoke("write", { path: requestSource, content: JSON.stringify(input) });
        if (!refused.isError) throw new Error("Invalid raw input was accepted");
      }
      if ((await state()).requests.length !== beforeInvalid) throw new Error("Invalid raw input reached HTTP");
      const unknown = await invoke("write", { path: requestSource, content: JSON.stringify({ query: "mutation FixtureUnknown { fixtureUnknown }", operationName: "FixtureUnknown" }) });
      if (!unknown.isError || action(unknown.result).effect !== "unknown") throw new Error("Unknown mutation looked successful");
      const unknownResponse = responseSource(unknown.result);
      await checked("read", { path: unknownResponse });
      if ((await state()).value !== "Unknown mutation saved") throw new Error("Unknown transport did not preserve its actual server-side fixture change");
      const partial = await invoke("write", { path: requestSource, content: JSON.stringify({ query: "mutation FixturePartial($value: String!) { fixtureChange(value: $value) { id value } }", variables: { value: "Partial mutation fixture" }, operationName: "FixturePartial" }) });
      if (!partial.isError || action(partial.result).outcome !== "partial" || action(partial.result).effect !== "unknown")
        throw new Error("Partial mutation status was lost");
      const partialResponse = responseSource(partial.result);
      const partialRead = await checked("read", { path: partialResponse });
      if (!rendered(partialRead).includes("Partial mutation fixture") || !rendered(partialRead).includes("Retained partial extension"))
        throw new Error("Partial response data or extensions were lost");
      if (args.headless) {
        const beforeTyped = (await state()).typedMutations.length;
        const typed = await invoke("write", { path: "linear://example/diff/30000000-0000-4000-8000-000000000003#merge", content: "{}" });
        if (!typed.isError || !rendered(typed.result).includes("LINEAR_CONFIRMATION_REQUIRED")) throw new Error("Typed approval gate was bypassed");
        if ((await state()).typedMutations.length !== beforeTyped) throw new Error("Denied typed mutation dispatched");
      }
      retained = { hasUI: context.hasUI, mode: context.mode, calls, queryResponse, mutationResponse, unknownResponse, partialResponse };
      return { content: [{ type: "text", text: "Controlled Linear API checks captured." }], details: retained };
    },
  });

  let responses = 0;
  pi.registerProvider("linear-raw-api-fixture", {
    name: "Local headless Linear API fixture", baseUrl: "https://linear-raw-api-fixture.invalid", apiKey: "fixture", api: "openai-completions",
    models: ["headless", "tui"].map(id => ({ id, name: "Controlled Linear fixture", reasoning: false, input: ["text"] as ("text")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 })),
    streamSimple(model) {
      const standalone = pi.getAllTools().some(tool => tool.name === "linear_read" && tool.exposure !== "hidden");
      const operations: [string, string, Record<string, string | number>][] = [
        ...(standalone ? [["discover", "tool_search", { query: "linear", limit: 20 }] as [string, string, Record<string, string | number>]] : []),
        ["guides", "read", { path: "docs:" }],
        ["api-guide", "read", { path: "docs:linear-api" }],
        ["schema", "read", { path: requestSource }],
        ["probe", "verify_linear_raw_api", {}],
        ...([["query-result", retained?.queryResponse], ["mutation-result", retained?.mutationResponse], ["unknown-result", retained?.unknownResponse], ["partial-result", retained?.partialResponse]] as const)
          .map(([id, source]): [string, string, Record<string, string | number>] => [id, "read", { path: source ?? requestSource }]),
      ];
      const index = responses++;
      const step = model.id === "tui" ? operations[index] : index === 0 ? ["headless-linear-api-probe", "verify_linear_raw_api", { headless: true }] as const : undefined;
      const first = step !== undefined;
      const tool = step && (standalone && !["verify_linear_raw_api", "tool_search"].includes(step[1]) ? "linear_" + step[1] : step[1]);
      const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: step ? [{ type: "toolCall", id: step[0], name: tool!, arguments: step[2] }] : [{ type: "text", text: "Controlled headless fixture finished." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now() };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
}

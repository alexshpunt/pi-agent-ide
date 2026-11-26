import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export const CODEX_CLIENT_VERSION = "0.151.0";
export type ActiveModel = { provider: string; api: string; id: string; baseUrl?: string };
export type NativeRegistry = Pick<
  ModelRegistry,
  "getAvailable" | "isUsingOAuth" | "getApiKeyAndHeaders" | "complete"
>;
type NativeResult = { text: string; provider: string; model: string };
type Input = {
  query: string;
  model: ActiveModel;
  modelRegistry: NativeRegistry;
  signal: AbortSignal;
  fetch: typeof fetch;
};
export interface NativeAdapter {
  id: string;
  search(input: Input): Promise<NativeResult>;
}

export function buildNativeSearchPrompt(query: string): string {
  return [
    "Answer immediately with the best self-contained response.",
    "You may include citations when useful.",
    "Do not ask follow-up questions or ask for more information.",
    "Do not describe what you are doing or add meta-commentary.",
    "Do not add conversational filler.",
    "Query:",
    query,
  ].join("\n");
}

function authHeaders(auth: {
  headers?: Record<string, string | null>;
  apiKey?: string;
}): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(auth.headers ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "authorization") && auth.apiKey)
    headers.Authorization = `Bearer ${auth.apiKey}`;
  return headers;
}

/** Select a supported OAuth Codex model without depending on the active model. */
export async function selectNativeSearch(input: {
  model?: ActiveModel;
  modelRegistry: NativeRegistry;
  signal: AbortSignal;
  fetch: typeof fetch;
  compatibility?: { codexClientVersion?: string };
}): Promise<{ model: ActiveModel; adapter: NativeAdapter } | undefined> {
  const registry = input.modelRegistry;
  const candidates =
    typeof registry.getAvailable === "function"
      ? registry
          .getAvailable()
          .filter(
            (model) =>
              model.provider === "openai-codex" &&
              model.api === "openai-codex-responses" &&
              registry.isUsingOAuth(model),
          )
      : [];
  if (!candidates.length) return undefined;
  const version =
    input.compatibility !== undefined
      ? input.compatibility.codexClientVersion
      : CODEX_CLIENT_VERSION;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return undefined;
  const first = candidates[0];
  if (!first) return undefined;
  const auth = await registry.getApiKeyAndHeaders(first);
  if (!auth.ok) throw new Error("Codex native-search authentication failed.");
  input.signal.throwIfAborted();
  const response = await input.fetch(
    `https://chatgpt.com/backend-api/codex/models?client_version=${version}`,
    { method: "GET", signal: input.signal, headers: authHeaders(auth) },
  );
  if (!response.ok)
    throw new Error(`Codex native-search capability request failed with HTTP ${response.status}.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Codex native-search capability response was malformed.");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    !("models" in body) ||
    !Array.isArray(body.models)
  )
    throw new Error("Codex native-search capability response was malformed.");
  const records: unknown[] = body.models;
  for (const model of candidates) {
    const matching = records.filter(
      (record): record is Record<string, unknown> =>
        record !== null &&
        typeof record === "object" &&
        "slug" in record &&
        record.slug === model.id,
    );
    if (matching.length > 1)
      throw new Error("Codex native-search capability response had duplicate model records.");
    const match = matching[0];
    if (!match) continue;
    if (typeof match.supports_search_tool !== "boolean")
      throw new Error("Codex native-search capability response had malformed model metadata.");
    if (!match.supports_search_tool) continue;
    const adapter: NativeAdapter = {
      id: "openai-codex-responses",
      async search(searchInput) {
        const result: unknown = await searchInput.modelRegistry.complete(
          searchInput.model as never,
          {
            messages: [
              {
                role: "user",
                content: buildNativeSearchPrompt(searchInput.query),
                timestamp: Date.now(),
              },
            ],
          },
          {
            signal: searchInput.signal,
            fetch: searchInput.fetch,
            onPayload: (payload: unknown) => ({
              ...(typeof payload === "object" && payload !== null ? payload : {}),
              model: searchInput.model.id,
              store: false,
              stream: true,
              tools: [{ type: "web_search", external_web_access: true }],
              tool_choice: "auto",
            }),
          },
        );
        if (!result || typeof result !== "object")
          throw new Error("Native search response was malformed.");
        if (!("content" in result) || !Array.isArray(result.content))
          throw new Error("Native search response was malformed.");
        const content: unknown[] = result.content;
        const text = content
          .filter(
            (part): part is { type: "text"; text: string } =>
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "text" &&
              "text" in part &&
              typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n");
        if (content.length > 0 && !text)
          throw new Error("Native search response had no usable text.");
        return { text, provider: searchInput.model.provider, model: searchInput.model.id };
      },
    };
    return { model, adapter };
  }
  return undefined;
}

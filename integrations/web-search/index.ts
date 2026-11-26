import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { loadWebsearchConfig } from "#src/config.ts";
import { formatWebSearchDoctorReport } from "#src/doctor.ts";
import {
  formatWebSearch,
  serperImageSearch,
  serperWebSearch,
  DEFAULT_RESULT_COUNT,
} from "#src/serper-search.ts";
import { connectResultsResource } from "#src/read-plugin.ts";
import {
  BACKGROUND_SEARCH_CARD,
  BACKGROUND_SEARCH_MESSAGE,
  BackgroundSearchRuntime,
  formatBackgroundSearchResult,
  type BackgroundSearchResult,
} from "#src/background-search.ts";
import { renderBackgroundSearchCard } from "#src/background-renderer.ts";
import type { JsonObject } from "#src/types.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const webSearchSchema = Type.Unsafe<{ query: string; limit?: number; background?: boolean }>({
  type: "object",
  required: ["query"],
  additionalProperties: false,
  properties: {
    query: { $ref: "#/$defs/WebSearchQuery" },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description:
        "Number of results to list. Defaults to 10. Serper returns about 10 results per page and charges 1 credit per page.",
    },
    background: {
      type: "boolean",
      description:
        "Return a request ID immediately and deliver each source result automatically as it becomes available. Defaults to false.",
    },
  },
  $defs: {
    WebSearchQuery: { type: "string", minLength: 1, description: "Plain web search query" },
  },
});
type WebSearchParameters = Static<typeof webSearchSchema>;
const backgroundResultSchema = Type.Unsafe<BackgroundSearchResult>(
  Type.Object({
    requestId: Type.String(),
    parentToolCallId: Type.Optional(Type.String()),
    query: Type.String(),
    status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
    durationMs: Type.Number(),
    search: Type.Optional(Type.Unknown()),
    error: Type.Optional(Type.String()),
  }),
);
const description =
  "Use web_search to search the public web through Serper. The reply lists the first results and names a websearch:<id> resource that holds the saved results: Read it with offset and limit for more, and Search it to find text or URLs. A Serper failure is returned as an error.";
const promptSnippet = "Search the public web through Serper.";
const imageSearchSchema = Type.Object(
  {
    query: Type.Optional(Type.String({ minLength: 1, description: "Text to search images for." })),
    image: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Image to search by, instead of query: a public image URL or a local image file path. A local file is uploaded to a third-party file host for the search; never pass an image that shows secrets or private data.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description: "Number of images to list in this reply. Defaults to 10.",
      }),
    ),
  },
  { additionalProperties: false },
);
type ImageSearchParameters = Static<typeof imageSearchSchema>;
const imageSearchDescription =
  "Use image_search to find images, such as references, by text, or to find similar images and the pages that show an image. A text query costs 2 Serper credits and saves 100 images; searching by image costs 3 credits and saves every match. The reply lists the first images with title, image URL, thumbnail, source page and size, and names a websearch:<id> resource: Read it with offset and limit for more, and Search it to find text or URLs. Read an image URL to view the image.";

/** Registers blocking/background search, explicit waiting, result cards, and the doctor command. */
export default async function registerWebSearch(pi: ExtensionAPI): Promise<void> {
  await connectResultsResource(pi);
  const background = new BackgroundSearchRuntime(pi);
  pi.on("tool_execution_start", (event) =>
    background.executionStarted(event.toolCallId, event.parentToolCallId),
  );
  pi.on("tool_execution_end", (event) => background.executionEnded(event.toolCallId));
  pi.on("session_start", (_event, ctx) => background.reset(ctx));
  pi.on("session_tree", (_event, ctx) => background.reset(ctx));
  pi.on("session_shutdown", () => background.reset());
  pi.on("turn_start", (_event, ctx) => background.resume(ctx));
  pi.on("turn_end", (event, ctx) => {
    background.setContext(ctx);
    return background.deliverBoundary(event);
  });
  pi.on("agent_before_settle", (event, ctx) => {
    background.setContext(ctx);
    return background.deliverBoundary(event);
  });
  pi.on("agent_settled", (_event, ctx) => {
    background.resume(ctx);
    background.deliverIdle();
  });
  pi.registerMessageRenderer<BackgroundSearchResult>(
    BACKGROUND_SEARCH_MESSAGE,
    (message, options, theme) =>
      message.details ? renderBackgroundSearchCard(message.details, options, theme) : undefined,
  );
  pi.registerEntryRenderer<BackgroundSearchResult>(
    BACKGROUND_SEARCH_CARD,
    (entry, options, theme) =>
      entry.data
        ? renderBackgroundSearchCard(entry.data, { ...options, outputPad: 0 }, theme)
        : undefined,
  );
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description,
    executionMode: "parallel",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    promptSnippet,
    promptGuidelines: [
      "Use web_search when the user mentions an external dependency, package, extension, product, service, or other external reference to find what they mean and get current information.",
      "Use web_search to verify external facts and find up-to-date information instead of relying on memory.",
      "When missing factual information can be found online, search with web_search before asking the user to clarify. Ask only if the search does not resolve the uncertainty or the question is about the user's intent or preferences.",
      "Use web_search with background: true to launch independent searches while doing other work. The launch receipt is not a search result. Each source result or failure arrives as a correlated message at a safe turn boundary and wakes an idle agent.",
      "Wait for search evidence before making decisions that depend on it. When no independent work remains, call wait_for_web_searches for pending source results; already delivered results are not repeated.",
    ],
    parameters: webSearchSchema,
    async execute(toolCallId, parameters: WebSearchParameters, signal, _onUpdate, context) {
      if (parameters.query.trim().length === 0)
        throw new Error("Web search query must not be empty");
      if (
        parameters.limit !== undefined &&
        (!Number.isInteger(parameters.limit) || parameters.limit < 1 || parameters.limit > 20)
      )
        throw new Error("Web search limit must be an integer from 1 to 20");
      const loaded = await loadWebsearchConfig({ cwd: context.cwd });
      if (!loaded.ok) throw new Error(loaded.message);
      signal?.throwIfAborted();
      const config = loaded.config;
      const maxResults = parameters.limit ?? config.maxResults ?? 10;
      const search = (ownedSignal: AbortSignal) =>
        serperWebSearch(
          config,
          { query: parameters.query, limit: maxResults, callId: toolCallId },
          ownedSignal,
        );
      if (parameters.background) {
        void background
          .startProgressive(toolCallId, parameters.query, search, context, true)
          .catch(() => {});
        const receipt = {
          requestId: toolCallId,
          query: parameters.query,
          status: "running" as const,
        };
        return {
          content: [
            {
              type: "text",
              text: `${JSON.stringify(receipt)}\nSource results arrive automatically. Continue independent work or call wait_for_web_searches.`,
            },
          ],
          details: receipt,
        };
      }
      const details = await background.startProgressive(
        toolCallId,
        parameters.query,
        search,
        context,
        false,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: `${formatWebSearch(details)}${background.isPending(toolCallId) ? `\n\nOther source results may arrive later for request ${toolCallId}.` : ""}`,
          },
        ],
        details,
      };
    },
  });
  pi.registerTool({
    name: "image_search",
    label: "Image search",
    description: imageSearchDescription,
    executionMode: "parallel",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    promptSnippet: "Find images by text, or similar images and pages for an image, through Serper.",
    parameters: imageSearchSchema,
    async execute(toolCallId, parameters: ImageSearchParameters, signal, _onUpdate, context) {
      const loaded = await loadWebsearchConfig({ cwd: context.cwd });
      if (!loaded.ok) throw new Error(loaded.message);
      const { text, details } = await serperImageSearch(
        loaded.config,
        {
          ...parameters,
          limit: parameters.limit ?? DEFAULT_RESULT_COUNT,
          callId: toolCallId,
          cwd: context.cwd,
        },
        signal,
      );
      return { content: [{ type: "text", text }], details };
    },
  });
  pi.registerTool({
    name: "wait_for_web_searches",
    label: "Wait for web searches",
    executionMode: "sequential",
    description:
      "Wait for the next available results from outstanding web searches. Returns source results not already delivered automatically; other sources may still be running. Searches launched afterward are not included. Interrupted waits fail.",
    promptSnippet: "Wait for outstanding background web search results.",
    parameters: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({ results: Type.Array(backgroundResultSchema) }),
    async execute(_id, _args, signal) {
      const results = await background.wait(signal);
      return {
        content: [
          {
            type: "text",
            text: results.length
              ? results.map(formatBackgroundSearchResult).join("\n\n")
              : "No outstanding web search results. Already delivered results are not repeated.",
          },
        ],
        details: { results },
        structuredContent: { results } as unknown as JsonObject,
      };
    },
    renderResult(result, _options, theme) {
      const count = result.details?.results.length;
      if (count === undefined)
        return new Text(
          result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
          0,
          0,
        );
      return new Text(
        theme.fg(
          "muted",
          count
            ? `Consumed ${count} web search ${count === 1 ? "result" : "results"}. Cards remain at the original calls.`
            : "No outstanding web search results.",
        ),
        0,
        0,
      );
    },
  });
  pi.registerCommand("pi-web-search-doctor", {
    description: "Check WebSearch configuration and provider credentials",
    handler: async (_arguments, context) => {
      const report = await formatWebSearchDoctorReport(context.cwd, process.env);
      pi.sendMessage(
        { customType: "pi-web-search-doctor", content: report, display: true },
        { triggerTurn: false },
      );
    },
  });
}

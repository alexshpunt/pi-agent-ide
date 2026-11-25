import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { confirmOperation } from "pi-agent-ide/api/approval";
import { registerAgentIdeSettings } from "pi-agent-ide/api/settings";
import { connectAgentDocumentation } from "pi-agent-ide/api/documentation";
import {
  connectReadPlugin,
  READ_API_VERSION,
  READ_PROTOCOL,
  type ReadHandler,
} from "pi-agent-ide/api/read";
import { connectSearchPlugin, SEARCH_API_VERSION, SEARCH_PROTOCOL } from "pi-agent-ide/api/search";
import {
  connectTextEditorPlugin,
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-ide/api/text-editor";
import {
  connectResultTargets,
  ResourceError,
  type ResourceResolver,
} from "pi-agent-ide/api/resource";
import { GithubApiResources, isGithubApiResource } from "./api.ts";
import { GithubContext } from "./context.ts";
import { textLineAnchors, withTextSourceLine } from "pi-agent-ide/api/text";
import { GithubConnections, type GithubConnectionBoundary } from "./connections/manager.ts";
import { registerGithubAuthCommands } from "./connections/commands.ts";
import {
  assertGithubAccess,
  fenceGithubResolver,
  githubOperationSignal,
} from "./connections/boundary.ts";
import { GithubBackend, type GithubApproval } from "./backend.ts";
import type { GithubAssets } from "./assets.ts";
import { parseGithubAddress } from "./address.ts";
import { actionRoute } from "./routes.ts";
import { createGithubResolver } from "./resource.ts";
import { createGithubSearchResolver, type ResourceTextReader } from "./search.ts";
import { createGithubEnvironmentProvider } from "./environment.ts";
import { createGithubBodySelectionHandler, createGithubReadOwnership } from "./selection.ts";
import { loadGithubGuides } from "./guidance.ts";
import { connectGithubMode } from "./modes.ts";
import {
  assertGithubMetadataSdk,
  githubResourceError,
  presentGithubRateLimit,
} from "./resource-error.ts";

function input(value: unknown): { path: string; content: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  return typeof item.path === "string" && typeof item.content === "string"
    ? { path: item.path, content: item.content }
    : undefined;
}

function typedAddress(source: string) {
  if (isGithubApiResource(source)) return undefined;
  try {
    return parseGithubAddress(source);
  } catch {
    return undefined;
  }
}
function registerGithubSettings(pi: ExtensionAPI): void {
  registerAgentIdeSettings(pi, "pi-agent-github", [
    {
      kind: "boolean",
      id: "pi-agent-github-yolo",
      name: "GitHub YOLO",
      description:
        "Skip confirmations for gated GitHub actions. Technical guards still apply; raw API calls are unchanged.",
      default: false,
      group: "features",
    },
  ]);
}

/** Shared policy grants permission; each dispatch still consumes its exact-target permit. */
function connectApproval(pi: ExtensionAPI, boundary?: GithubConnectionBoundary): GithubApproval {
  const permits = new Set<string>();
  const unsubscribe = boundary?.onChange(() => permits.clear());
  pi.on("tool_call", async (event, context) => {
    if (!["write", "replace", "insert"].includes(event.toolName)) return;
    const args = event.input as Record<string, unknown>;
    if (typeof args.path !== "string") return;
    const address = typedAddress(args.path);
    if (!address) return;
    const route = actionRoute(address);
    let payload: Record<string, unknown> | undefined;
    if (typeof args.content === "string") {
      try {
        const parsed: unknown = JSON.parse(args.content);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
          payload = parsed as Record<string, unknown>;
      } catch {}
    }
    const highRisk =
      route?.dangerous ||
      (route?.kind === "review" && payload?.event !== undefined) ||
      (address.parts[0] === "releases" &&
        (payload?.draft === false || ["draft", "fields"].includes(address.facet ?? ""))) ||
      /^releases\/\d+\/assets\/new$/.test(address.parts.join("/"));
    if (!highRisk) return;
    const access = await boundary?.capture(context.cwd, context.signal);
    const signal = githubOperationSignal(access, context.signal);
    await access?.credentials.initialize(signal);
    if (
      !(await confirmOperation(pi.events, context, {
        owner: access?.owner ?? "pi-agent-github",
        category: route?.kind ?? "release change",
        yoloSetting: "pi-agent-github-yolo",
        title: "Confirm GitHub action",
        message: `${event.toolName}: ${address.source}\n${route?.kind ?? "release change"}\n${typeof args.content === "string" ? args.content : JSON.stringify(args)}`,
        signal,
      }))
    )
      return { block: true, reason: "GH_APPROVAL_REQUIRED" };
    assertGithubAccess(access, address.source);
    permits.add(address.source);
  });
  pi.on("tool_result", (event) => {
    const args = event.input;
    if (typeof args.path === "string") {
      const address = typedAddress(args.path);
      if (address) permits.delete(address.source);
    }
  });
  pi.on("session_shutdown", () => {
    permits.clear();
    unsubscribe?.();
  });
  return async (source) => permits.delete(source);
}

/** Keep provider failures explicit in both native rendering and nested tool results. */
function failedGithubAction(error: ResourceError, source: string, savedResponse?: string) {
  return {
    source: savedResponse ?? source,
    summary: `GitHub request failed: ${error.code}.\nEffect: ${error.effect}.\nTarget: ${source}${savedResponse ? `\nRead saved response: ${savedResponse}` : ""}\nInspect the affected resource before another change; never replay an unknown mutation.`,
    data: {
      kind: "github-failure",
      ok: false,
      code: error.code,
      effect: error.effect,
      ...(error.metadata ? { metadata: error.metadata } : {}),
    },
  };
}
function createContextResolver(contexts: GithubContext): ResourceResolver {
  return {
    id: "github-context",
    async tryResolve(source, context) {
      try {
        const snapshot = await contexts.read(source, context.cwd, context.signal);
        if (!snapshot) return { kind: "not-handled" };
        const bytes = snapshot.bytes;
        return {
          kind: "resolved",
          resource: {
            source: snapshot.source,
            read: async () => [{ type: "text", text: snapshot.content }],
            ...(bytes
              ? {
                  readBytes: async (offset, limit, operation) => {
                    operation.signal?.throwIfAborted();

                    const start = Math.min(
                      bytes.length,
                      Math.max(0, offset < 0 ? bytes.length + offset : offset),
                    );
                    return {
                      bytes: Uint8Array.from(
                        bytes.subarray(start, start + (limit ?? bytes.length)),
                      ),
                      byteOffset: start,
                      totalBytes: bytes.length,
                    };
                  },
                }
              : {}),
          },
        };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        return {
          kind: "failed",
          error: githubResourceError(error, source, "GH_CONTEXT_READ_FAILED"),
        };
      }
    },
  };
}
const bodyProvenance: ReadHandler = (context) => {
  const state = context.state;
  if (
    state?.contentKind !== "text" ||
    !["github", "github-api", "github-context"].includes(state.resolvedBy)
  )
    return { kind: "continue", context };
  if (state.resolvedBy === "github") {
    const address = parseGithubAddress(state.source);
    if (
      address?.parts[0] !== "file" &&
      (context.sourceText !== state.text.content ||
        !address?.facet ||
        ["schema", "actions"].includes(address.facet))
    )
      return { kind: "continue", context };
  }
  const anchors =
    context.sourceText === state.text.content
      ? textLineAnchors(state.source, context.sourceText)
      : undefined;
  return {
    kind: "continue",
    context: {
      ...context,
      state: {
        ...state,
        text: {
          ...state.text,
          lines: state.text.lines.map((line) =>
            withTextSourceLine(line, {
              source: state.source,
              lineNumber: line.lineNumber,
              content: line.content,
              ...(anchors?.[line.lineNumber - 1] === undefined
                ? {}
                : { anchor: anchors[line.lineNumber - 1] }),
            }),
          ),
        },
      },
    },
  };
};

/** Reuse one backend through ordinary IDE tools or an isolated standalone host. */
export async function registerGithubProvider(
  pi: ExtensionAPI,
  backend: GithubBackend,
  assets?: GithubAssets,
  boundary?: GithubConnectionBoundary,
): Promise<void> {
  assertGithubMetadataSdk();
  registerGithubSettings(pi);
  await connectGithubMode(pi, (api, mode) =>
    connectGithubProvider(api, backend, mode, assets, boundary),
  );
}

async function connectGithubProvider(
  pi: ExtensionAPI,
  backend: GithubBackend,
  mode: "ide" | "standalone",
  assets?: GithubAssets,
  boundary?: GithubConnectionBoundary,
): Promise<void> {
  connectAgentDocumentation(pi, [
    ...(await loadGithubGuides()),
    ...(mode === "standalone"
      ? [
          {
            id: "editing",
            description: "Edit bounded GitHub resource text and use typed action schemas",
            triggers: [{ tool: "read", resourcePrefixes: ["docs:editing"] }],
            markdown:
              "# GitHub editing\n\nRead the specific body, field or file before editing; cards are read-only. Use returned anchors or unique exact text with Replace, Insert or Delete. Pass unchanged Read, Search and Select results to keep their exact bounds. Reread after changes. Use Write for complete resource text or JSON at a displayed action schema. Read docs:github-issues, docs:github-files or docs:github-api for the selected resource. Standalone is always YOLO; keep token permissions, stale-target checks and unknown-effect recovery intact.\n",
          },
        ]
      : []),
  ]);
  const apiResources = new GithubApiResources(backend.client);
  const contextResources = new GithubContext(backend.client);
  const contextResolver = fenceGithubResolver(createContextResolver(contextResources), boundary);
  const apiResolver = fenceGithubResolver(apiResources.resolver(), boundary);
  const assetResolver = assets && fenceGithubResolver(assets.resolver(), boundary);
  const targets = connectResultTargets(pi);
  const searchSources = new Set<string>();
  const unsubscribe = boundary?.onChange(() => {
    apiResources.clear();
    // Strict SDK Search handles reread through Read, independently of refresh callbacks.
    for (const source of searchSources) targets.invalidate(source);
    searchSources.clear();
  });
  pi.on("session_shutdown", () => {
    apiResources.clear();
    unsubscribe?.();
  });
  const approve: GithubApproval =
    mode === "standalone" ? async () => true : connectApproval(pi, boundary);
  const resolver = fenceGithubResolver(createGithubResolver(backend, approve, assets), boundary);
  const readText: ResourceTextReader = async (source, cwd, callerSignal) => {
    const access = await boundary?.capture(cwd, callerSignal);
    const signal = githubOperationSignal(access, callerSignal);
    let result: Awaited<ReturnType<ResourceTextReader>>;
    const contextual = await contextResources.read(source, cwd, signal);
    if (contextual) result = contextual;
    else {
      const generic = await apiResources.readText(source, cwd, signal);
      if (generic) result = generic;
      else {
        const address = parseGithubAddress(source);
        if (!address) throw new Error("GH_INVALID_SEARCH_SCOPE");
        const snapshot = await backend.read(address, cwd, signal);
        result = { source: address.source, content: snapshot.content };
      }
    }
    assertGithubAccess(access, source);
    searchSources.add(source);
    searchSources.add(result.source);
    return result;
  };
  pi.on("tool_result", (event) => {
    const details = event.details as
      | { metadata?: { semanticAction?: Record<string, unknown> } }
      | undefined;
    const receipt = details?.metadata?.semanticAction;
    const presentation = presentGithubRateLimit(event);
    if (receipt?.kind === "github-failure" && receipt.ok === false) {
      return {
        ...presentation,
        isError: true,
        details: { ...(event.details as object), effect: receipt.effect },
      };
    }
    if (presentation) return presentation;
    if (receipt?.kind !== "github-action" || typeof receipt.source !== "string" || event.isError)
      return;
    const { source, url } = receipt;
    const includes = (value: string) =>
      event.content.some((block) => block.type === "text" && block.text.includes(value));
    const sourceLine = includes(source) ? "" : `Read: ${source}\n`;
    const urlLine = typeof url === "string" && !includes(url) ? `GitHub URL: ${url}\n` : "";
    if (!sourceLine && !urlLine) return;
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: `${sourceLine}${urlLine}Effect: applied. Read before editing.`,
        },
      ],
      ...(event.structuredContent === undefined
        ? {}
        : { structuredContent: event.structuredContent }),
    };
  });
  await Promise.all([
    connectReadPlugin(pi, {
      protocol: READ_PROTOCOL,
      apiVersion: READ_API_VERSION,
      id: "github",
      setup(api) {
        api.addResolver({ resolver: contextResolver, priority: -240 });
        api.addResolver({ resolver: apiResolver, priority: -230 });
        if (assetResolver) api.addResolver({ resolver: assetResolver, priority: -220 });
        api.addResolver({ resolver, priority: -200 });
        const ownership = createGithubReadOwnership(boundary);
        api.addHandler({ stage: "pre-read", handler: ownership.preRead });
        api.addHandler({
          stage: "read",
          when: { resolvedBy: "any", contentKind: "text" },
          handler: bodyProvenance,
        });
        const selections = new Map(
          ["github", "github-api", "github-context"].map((id) => [
            id,
            createGithubBodySelectionHandler(
              targets,
              api.read,
              id,
              id === "github" ? undefined : () => true,
              ownership,
            ),
          ]),
        );
        const fileSelection = createGithubBodySelectionHandler(
          targets,
          api.read,
          "github",
          (source) => typedAddress(source)?.parts[0] === "file",
          ownership,
        );
        api.addHandler({
          stage: "post-read",
          handler(context) {
            const state = context.state;
            const handler =
              state?.resolvedBy === "github" && typedAddress(state.source)?.parts[0] === "file"
                ? fileSelection
                : selections.get(state?.resolvedBy ?? "");
            return handler ? handler(context) : { kind: "continue", context };
          },
        });
        api.describe({
          path: "GitHub browser/API URLs and displayed github: resources. Cards, bodies, fields, API responses and linked resources stay separate. Start with docs:github, then choose its domain guide.",
        });
      },
    }),
    connectSearchPlugin(pi, {
      protocol: SEARCH_PROTOCOL,
      apiVersion: SEARCH_API_VERSION,
      id: "github",
      setup(api) {
        api.addEnvironmentProvider(createGithubEnvironmentProvider(readText));
        api.addResolver({
          priority: -200,
          resolver: createGithubSearchResolver(
            (request, cwd, signal) => backend.discover(request, cwd, signal),
            readText,
            (selection, context) => api.registerSelection(selection, context),
            boundary,
          ),
        });
        api.describe(
          "GitHub repository-scoped discovery and selected-resource text Search, including API responses. Read docs:github-discovery. Keep shared scopes bounded; read linked resources separately.",
        );
      },
    }),
    connectTextEditorPlugin(pi, {
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      id: "github",
      setup(api) {
        api.addResolver({ resolver: contextResolver, priority: -240 });
        api.addResolver({ resolver: apiResolver, priority: -230 });
        api.addResolver({ resolver, priority: -200 });
        api.tool("write").addSemanticHandler({
          matches(value) {
            const args = input(value);
            if (args && apiResources.ownsAction(args.path)) return true;
            const address = args && typedAddress(args.path);
            return (
              !!address &&
              (address.parts.at(-1) === "new" ||
                ["submit", "merge", "reply", "resolve", "unresolve"].includes(
                  address.parts.at(-1) ?? "",
                ))
            );
          },
          async execute(context, value) {
            const access = await boundary?.capture(context.cwd, context.signal);
            const signal = githubOperationSignal(access, context.signal);
            const args = input(value);
            if (args && apiResources.ownsAction(args.path)) {
              try {
                const receipt = await apiResources.perform(
                  args.path,
                  args.content,
                  context.cwd,
                  signal,
                );
                return {
                  source: receipt.source,
                  summary: `GitHub API request completed.\nStatus: ${receipt.status}\nRead: ${receipt.source}\nInspect the response and reread the target before another change.`,
                  data: { kind: "github-api-response", ...receipt },
                  script: { source: receipt.source },
                };
              } catch (error) {
                if (!(error instanceof ResourceError)) throw error;
                return failedGithubAction(
                  error,
                  args.path,
                  apiResources.failureResponse(error)?.source,
                );
              }
            }
            const address = args && parseGithubAddress(args.path);
            if (!args || !address)
              throw new ResourceError("GH_INVALID_URI", args?.path ?? "github:", "not-applied");
            if (Buffer.byteLength(args.content) > 2 * 1024 * 1024)
              throw new ResourceError("GH_CONTENT_TOO_LARGE", address.source, "not-applied");
            try {
              const receipt = assets?.owns(address)
                ? await assets.upload(address, args.content, context.cwd, signal, approve)
                : await backend.perform(address, args.content, context.cwd, signal, approve);
              return {
                source: receipt.source,
                summary: `GitHub action applied.\nRead: ${receipt.source}${receipt.url ? `\nURL: ${receipt.url}` : ""}\nRead the returned resource before editing.`,
                data: { kind: "github-action", ...receipt },
                script: { source: receipt.source },
              };
            } catch (error) {
              if (!(error instanceof ResourceError)) throw error;
              return failedGithubAction(error, address.source);
            }
          },
        });
        api.describe(
          "GitHub uses ordinary editors for resource bodies/fields and Write for typed actions or arbitrary REST/GraphQL. Read docs:github, then the selected schema or docs:github-api. Reread after changes; never replay unknown effects.",
        );
      },
    }),
  ]);
}

/** Authentication and selected identity are local and owned by this Pi session. */
export default async function githubExtension(pi: ExtensionAPI): Promise<void> {
  const connections = new GithubConnections();
  const clientFor = (cwd: string) => connections.clientFor(cwd);
  registerGithubAuthCommands(pi, connections);
  pi.on("session_shutdown", () => connections.dispose());
  const { GithubCollaboration } = await import("./collaboration.ts");
  const { GithubAssets } = await import("./assets.ts");
  await registerGithubProvider(
    pi,
    new GithubBackend(clientFor, new GithubCollaboration(clientFor)),
    new GithubAssets((cwd) => connections.credentialsFor(cwd), clientFor),
    connections,
  );
}

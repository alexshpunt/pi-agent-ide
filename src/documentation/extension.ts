import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectReadPlugin } from "pi-agent-read/api/connect-plugin";
import { READ_API_VERSION, READ_PROTOCOL } from "pi-agent-read/api/plugin-protocol";
import {
  DOCUMENTATION_API_VERSION,
  DOCUMENTATION_PROTOCOL,
  DOCUMENTATION_READY_EVENT,
  DOCUMENTATION_REGISTER_EVENT,
  type AgentDocumentation,
} from "#src/api/documentation.js";
import { AgentDocumentationRegistry } from "#src/documentation/registry.js";

interface RegistrationRequest {
  readonly documents: readonly AgentDocumentation[];
}

const READ_RECORD = "agent-documentation-read";

/** Exposes packaged guides and adds unread guides to results without blocking tools. */
export default async function registerProgressiveDocumentation(pi: ExtensionAPI): Promise<void> {
  const registry = new AgentDocumentationRegistry();
  const claimed = new Set<string>();
  const parents = new Map<string, string>();
  const pendingGuides = new Map<string, readonly AgentDocumentation[]>();
  const remember = (ids: readonly string[]): void => {
    const unread = ids.filter((id) => !claimed.has(id));
    if (unread.length === 0) return;
    // Separate records survive bounded nested-call metadata and stay on their own branch.
    pi.appendEntry(READ_RECORD, { ids: unread });
    for (const id of unread) claimed.add(id);
  };
  const unsubscribe = pi.events.on(DOCUMENTATION_REGISTER_EVENT, (value) => {
    if (!isRegistrationRequest(value)) throw new Error("Invalid agent documentation registration");
    registry.register(value.documents);
  });
  pi.on("session_shutdown", unsubscribe);

  await connectReadPlugin(pi, {
    protocol: READ_PROTOCOL,
    apiVersion: READ_API_VERSION,
    id: "agent-documentation",
    setup(api) {
      api.addResolver({
        resolver: {
          id: "agent-documentation",
          tryResolve(source) {
            if (!source.startsWith("docs:"))
              return Promise.resolve({ kind: "not-handled" as const });
            const id = source.slice("docs:".length);
            const document = id.length === 0 ? undefined : registry.get(id);
            const markdown = id.length === 0 ? renderListing(registry.list()) : document?.markdown;
            if (markdown === undefined) {
              return Promise.resolve({
                kind: "failed" as const,
                error: new Error(`Unknown documentation ID: ${id}`),
              });
            }
            return Promise.resolve({
              kind: "resolved" as const,
              resource: {
                source,
                read: () => Promise.resolve([{ type: "text" as const, text: markdown }]),
              },
            });
          },
        },
      });
      api.describe({
        path: () =>
          registry.list().length === 0
            ? undefined
            : "docs: lists packaged agent guidance; docs:<id> reads a listed guide.",
      });
      api.addPromptGuideline(() => renderPromptGuideline(registry.list()));
    },
  });

  pi.on("session_start", (_event, context) => {
    restoreClaims(context.sessionManager.getBranch(), registry, claimed);
  });
  pi.on("session_tree", (_event, context) => {
    restoreClaims(context.sessionManager.getBranch(), registry, claimed);
  });
  pi.on("session_compact", (_event, context) => {
    restoreClaims(context.sessionManager.getBranch(), registry, claimed);
  });

  pi.on("tool_call", (event) => {
    if (event.toolCallId.includes("-preflight-")) return;
    if (event.parentToolCallId !== undefined) parents.set(event.toolCallId, event.parentToolCallId);
  });
  pi.on("tool_result", (event) => {
    if (event.toolCallId.includes("-preflight-")) return;
    const parent = parents.get(event.toolCallId);
    parents.delete(event.toolCallId);
    const inherited = pendingGuides.get(event.toolCallId) ?? [];
    pendingGuides.delete(event.toolCallId);
    const docsSource = event.toolName === "read" ? documentationSource(event.input) : undefined;
    if (docsSource !== undefined) {
      const id = docsSource.slice("docs:".length);
      const known = id.length === 0 || registry.get(id) !== undefined;
      const document = registry.get(id);
      if (document !== undefined && !event.isError && containsFullGuide(event.content, document))
        remember([id]);
      return {
        content: event.content,
        structuredContent: event.structuredContent,
        details: {
          ...(isRecord(event.details) ? event.details : {}),
          documentation: known
            ? id.length === 0
              ? { kind: "list", ids: registry.list().map((document) => document.id) }
              : { kind: "document", id }
            : { kind: "error", code: "UNKNOWN_DOCUMENTATION", id },
        },
        isError: event.isError,
      };
    }
    const documents = [
      ...inherited,
      ...registry
        .matching(event.toolName, event.input)
        .filter((document) => !claimed.has(document.id)),
    ];
    if (documents.length === 0) return;
    remember(documents.map((document) => document.id));
    // Keep nested source strings minimal and deliver guidance once on the parent result.
    if (parent !== undefined) {
      pendingGuides.set(parent, [...(pendingGuides.get(parent) ?? []), ...documents]);
      return;
    }
    return {
      content: [
        ...event.content,
        ...documents.map((document) => ({
          type: "text" as const,
          text: `\n\n---\n\n# Guide: ${document.id}\n\n${document.markdown.trim()}`,
        })),
      ],
      structuredContent: event.structuredContent,
      details: {
        ...(isRecord(event.details) ? event.details : {}),
        documentation: { kind: "attachment", ids: documents.map((document) => document.id) },
      },
      isError: event.isError,
    };
  });

  pi.events.emit(DOCUMENTATION_READY_EVENT, {
    protocol: DOCUMENTATION_PROTOCOL,
    apiVersion: DOCUMENTATION_API_VERSION,
  });
}

function renderListing(documents: readonly AgentDocumentation[]): string {
  if (documents.length === 0) return "No agent documentation is currently available.";
  return [
    "# Available agent documentation",
    "",
    ...documents.map((doc) => `- \`${doc.id}\` — ${doc.description}`),
  ].join("\n");
}

function renderPromptGuideline(documents: readonly AgentDocumentation[]): string | undefined {
  if (documents.length === 0) return undefined;
  return [
    "Read the matching docs:<id> before using any tool or feature with packaged guidance, including tools discovered later or called through Codemode. Read each guide once per branch. Tool descriptions and docs: listings do not replace the full guide.",
    "If a result includes a Guide, read it before your next use. The call has already run: do not repeat it just to obtain documentation. Nested calls keep their guides on the parent result, even when the script does not print the child output.",
    "Available documents:",
    ...documents.map((document) => `  - ${document.id} — ${document.description}`),
  ].join("\n");
}

function restoreClaims(
  branch: readonly unknown[],
  registry: AgentDocumentationRegistry,
  claimed: Set<string>,
): void {
  claimed.clear();
  for (const entry of branch) {
    if (!isRecord(entry)) continue;
    if (entry.type === "custom" && entry.customType === READ_RECORD && isRecord(entry.data)) {
      addIds(entry.data.ids);
      continue;
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role !== "toolResult" || !isRecord(message.details)) continue;
    const documentation = message.details.documentation;
    if (!isRecord(documentation)) continue;
    if (documentation.kind === "attachment") addIds(documentation.ids);
    if (
      documentation.kind === "document" &&
      !message.isError &&
      typeof documentation.id === "string"
    ) {
      const document = registry.get(documentation.id);
      if (document !== undefined && containsFullGuide(message.content, document))
        addIds([document.id]);
    }
  }
  function addIds(ids: unknown): void {
    if (!Array.isArray(ids)) return;
    for (const id of ids)
      if (typeof id === "string" && registry.get(id) !== undefined) claimed.add(id);
  }
}

function containsFullGuide(content: unknown, document: AgentDocumentation): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (part: unknown) =>
        isRecord(part) &&
        part.type === "text" &&
        typeof part.text === "string" &&
        part.text.includes(document.markdown.trim()),
    )
  );
}
function documentationSource(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.path !== "string" || !input.path.startsWith("docs:"))
    return undefined;
  return input.path;
}

function isRegistrationRequest(value: unknown): value is RegistrationRequest {
  return isRecord(value) && Array.isArray(value.documents);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

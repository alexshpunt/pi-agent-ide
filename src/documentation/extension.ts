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
import {
  type InterceptResult,
  registerToolCallInterceptor,
  type ToolCallInterceptorHandler,
} from "pi-agent-text-editor/api/tool-call-interceptor";

interface RegistrationRequest {
  readonly documents: readonly AgentDocumentation[];
}

/** Registers progressive documentation discovery, resources, and first-use attachments. */
export default async function registerProgressiveDocumentation(pi: ExtensionAPI): Promise<void> {
  const registry = new AgentDocumentationRegistry();
  const claimed = new Set<string>();
  const fallbackGates = new Map<string, readonly AgentDocumentation[]>();
  const gatedToolNames: string[] = [];
  const gateHandler: ToolCallInterceptorHandler = {
    name: "agent-documentation-first-use",
    blockExecution: true,
    toolNames: gatedToolNames,
    intercept(context): InterceptResult | undefined {
      if (process.env.PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE === "1") return;
      if (context.toolCall.id.includes("-preflight-")) return;
      const documents = claimMatchingGuides(
        registry,
        claimed,
        context.toolCall.name,
        context.partialArgs ?? context.args,
      );
      if (documents.length === 0) return;
      fallbackGates.set(context.toolCall.id, documents);
      sendGuideToAgent(pi, documents);
      return guideGateResult(documents);
    },
  };
  registerToolCallInterceptor(pi, gateHandler);
  const unsubscribe = pi.events.on(DOCUMENTATION_REGISTER_EVENT, (value) => {
    if (!isRegistrationRequest(value)) throw new Error("Invalid agent documentation registration");
    registry.register(value.documents);
    gatedToolNames.splice(
      0,
      gatedToolNames.length,
      ...new Set(
        registry.list().flatMap((document) => document.triggers.map((trigger) => trigger.tool)),
      ),
    );
    registerToolCallInterceptor(pi, gateHandler);
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
      api.describe(() =>
        registry.list().length === 0
          ? undefined
          : "docs: and docs:<id> — list or read packaged agent guidance.",
      );
      api.addPromptGuideline(() => renderPromptGuideline(registry.list()));
    },
  });

  pi.on("session_start", (_event, context) => {
    restoreClaims(context.sessionManager.getBranch(), registry, claimed);
  });

  pi.on("tool_call", (event, context) => {
    if (process.env.PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE === "1") return;
    if (event.toolCallId.includes("-preflight-")) return;
    restoreClaims(context.sessionManager.getBranch(), registry, claimed);
    const documents = claimMatchingGuides(registry, claimed, event.toolName, event.input);
    if (documents.length === 0) return;
    fallbackGates.set(event.toolCallId, documents);
    sendGuideToAgent(pi, documents);
    return { block: true, reason: guideNotice(documents) };
  });
  pi.on("tool_result", (event, context) => {
    if (event.toolCallId.includes("-preflight-")) return;
    const fallbackDocuments = fallbackGates.get(event.toolCallId);
    if (fallbackDocuments !== undefined) {
      fallbackGates.delete(event.toolCallId);
      return {
        content: [{ type: "text" as const, text: guideNotice(fallbackDocuments) }],
        details: documentationGateDetails(fallbackDocuments),
        isError: true,
      };
    }
    restoreClaims(context.sessionManager.getBranch(), registry, claimed, event.toolCallId);
    const docsSource = documentationSource(event.input);
    if (docsSource !== undefined) {
      const id = docsSource.slice("docs:".length);
      const available = registry.list();
      const known = id.length === 0 || registry.get(id) !== undefined;
      if (id.length > 0 && known) claimed.add(id);
      return {
        content: event.content,
        details: {
          ...(isRecord(event.details) ? event.details : {}),
          documentation: known
            ? id.length === 0
              ? { kind: "list", ids: available.map((document) => document.id) }
              : { kind: "document", id }
            : { kind: "error", code: "UNKNOWN_DOCUMENTATION", id },
        },
        isError: event.isError,
      };
    }
    if (process.env.PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE === "1") return;
    const documents = registry
      .matching(event.toolName, event.input)
      .filter((document) => !claimed.has(document.id));
    if (documents.length === 0) return;
    for (const document of documents) claimed.add(document.id);
    return {
      content: [
        ...event.content,
        ...documents.map((document) => ({
          type: "text" as const,
          text: `\n\n---\n\n# Guide: ${document.id}\n\n${document.markdown.trim()}`,
        })),
      ],
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

function claimMatchingGuides(
  registry: AgentDocumentationRegistry,
  claimed: Set<string>,
  toolName: string,
  input: unknown,
): readonly AgentDocumentation[] {
  const documents = registry
    .matching(toolName, input)
    .filter((document) => !claimed.has(document.id));
  for (const document of documents) claimed.add(document.id);
  return documents;
}

function renderGuideGate(documents: readonly AgentDocumentation[]): string {
  return [
    "[SYSTEM] Read the attached guide before using this tool. Repeat the tool call after reading it.",
    ...documents.map(
      (document) => `\n\n---\n\n# Guide: ${document.id}\n\n${document.markdown.trim()}`,
    ),
  ].join("");
}

function guideNotice(documents: readonly AgentDocumentation[]): string {
  return `Guide sent to agent: ${documents.map((document) => document.id).join(", ")}. Repeat the tool call.`;
}

function sendGuideToAgent(pi: ExtensionAPI, documents: readonly AgentDocumentation[]): void {
  pi.sendMessage({
    customType: "agent-documentation-first-use",
    content: renderGuideGate(documents),
    display: false,
    details: documentationGateDetails(documents),
  });
}

function documentationGateDetails(documents: readonly AgentDocumentation[]): {
  readonly documentation: { readonly kind: "gate"; readonly ids: readonly string[] };
} {
  return { documentation: { kind: "gate", ids: documents.map((document) => document.id) } };
}

function guideGateResult(documents: readonly AgentDocumentation[]): InterceptResult {
  return {
    annotation: { kind: "blocked", reason: "Read the first-use guide, then retry." },
    message: {
      customType: "agent-documentation-first-use",
      content: guideNotice(documents),
      display: false,
      details: documentationGateDetails(documents),
    },
  };
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
    "Read docs:<id> for detailed packaged guidance when needed. Available documents:",
    ...documents.map((document) => `  - ${document.id} — ${document.description}`),
  ].join("\n");
}

function restoreClaims(
  branch: readonly unknown[],
  registry: AgentDocumentationRegistry,
  claimed: Set<string>,
  currentToolCallId?: string,
): void {
  for (const entry of branch) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.toolCallId === currentToolCallId) continue;
    if (typeof message.toolCallId === "string" && message.toolCallId.includes("-preflight-"))
      continue;
    if (message.role !== "toolResult" || typeof message.toolName !== "string") continue;
    if (isRecord(message.details) && isRecord(message.details.documentation)) {
      const documentation = message.details.documentation;
      const ids = documentation.ids;
      if (Array.isArray(ids)) {
        for (const id of ids)
          if (typeof id === "string" && registry.get(id) !== undefined) claimed.add(id);
        continue;
      }
      if (
        documentation.kind === "document" &&
        typeof documentation.id === "string" &&
        registry.get(documentation.id) !== undefined
      ) {
        claimed.add(documentation.id);
        continue;
      }
    }
    const input = message.input ?? sourceInput(message.details);
    for (const document of registry.matching(message.toolName, input)) claimed.add(document.id);
  }
}

function documentationSource(input: unknown): string | undefined {
  if (!isRecord(input) || typeof input.path !== "string" || !input.path.startsWith("docs:"))
    return undefined;
  return input.path;
}

function sourceInput(details: unknown): { readonly path: string } | undefined {
  if (!isRecord(details) || typeof details.source !== "string") return undefined;
  return { path: details.source };
}

function isRegistrationRequest(value: unknown): value is RegistrationRequest {
  return isRecord(value) && Array.isArray(value.documents);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

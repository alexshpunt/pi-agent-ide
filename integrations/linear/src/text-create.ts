import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-ide/api/resource";
import { linearErrorRateLimit, linearResourceError } from "./resource-failure.ts";
import { parseTextAddress, type LinearTextAddress } from "./text-address.ts";
import { isDocumentId, parseDocumentUrl, parseIssueUrl } from "./urls.ts";

type CreationAddress = Extract<
  LinearTextAddress,
  { readonly kind: "create-document" | "create-comment" }
>;
import type { LinearSemanticHandler as SemanticHandler } from "./semantic.ts";

/** Canonical receipt returned only after one acknowledged remote creation. */
export interface CreatedLinearText {
  readonly id: string;
  readonly source: string;
  readonly url: string;
}

/** Preserve verified creation links when the common Write receipt is compacted. */
export function connectLinearCreationReceipts(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "write" || event.isError) return;
    const details = event.details as { metadata?: { semanticAction?: unknown } } | undefined;
    const value = details?.metadata?.semanticAction;
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const action = value as Record<string, unknown>;
    if (
      (action.kind !== "linear-document-create" && action.kind !== "linear-comment-create") ||
      action.effect !== "applied" ||
      typeof action.id !== "string" ||
      typeof action.source !== "string" ||
      typeof action.url !== "string"
    )
      return;
    const input = parameters(event.input);
    const address = input && parseTextAddress(input.path);
    if (!address || (address.kind !== "create-document" && address.kind !== "create-comment"))
      return;
    try {
      checkedReceipt({ id: action.id, source: action.source, url: action.url }, address);
    } catch {
      return;
    }
    const hasUrl = event.content.some(
      (block) => block.type === "text" && block.text.includes(action.url as string),
    );
    if (hasUrl) return;
    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: `Linear URL: ${action.url}\nRead: ${action.source}`,
        },
      ],
      ...(event.structuredContent === undefined
        ? {}
        : { structuredContent: event.structuredContent }),
    };
  });
}

/** Creation stays inside the existing Write invocation; transport is owned by the backend. */
export type LinearTextCreator = (
  address: CreationAddress,
  content: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<CreatedLinearText>;

function parameters(value: unknown): { path: string; content: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  return typeof input.path === "string" && typeof input.content === "string"
    ? { path: input.path, content: input.content }
    : undefined;
}

function checkedReceipt(created: CreatedLinearText, address: CreationAddress): void {
  if (!isDocumentId(created.id)) throw new Error("LINEAR_INVALID_RESPONSE");
  if (address.kind === "create-document") {
    const source = parseTextAddress(created.source);
    const native = parseDocumentUrl(created.url);
    if (
      source?.kind !== "document-content" ||
      source.identifier !== created.id.toLowerCase() ||
      source.workspace !== address.workspace ||
      !native ||
      native.workspace !== address.workspace ||
      (!native.native && native.identifier !== created.id.toLowerCase())
    ) {
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    }
  } else {
    const expected = `linear://${address.workspace}/issue/${address.identifier}/comment/${created.id.toLowerCase()}`;
    const native = parseIssueUrl(created.url);
    if (
      created.source !== expected ||
      native?.workspace !== address.workspace ||
      native.identifier !== address.identifier
    ) {
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    }
  }
}

/** Handle creation addresses through the public semantic Write extension point. */
export function createLinearTextCreationHandler(create: LinearTextCreator): SemanticHandler {
  return {
    matches(value) {
      const input = parameters(value);
      if (!input) return false;
      const address = parseTextAddress(input.path);
      return address?.kind === "create-document" || address?.kind === "create-comment";
    },
    async execute(context, value) {
      const input = parameters(value);
      const address = input && parseTextAddress(input.path);
      if (
        !input ||
        !address ||
        (address.kind !== "create-document" && address.kind !== "create-comment")
      ) {
        throw new ResourceError("LINEAR_INVALID_URL", input?.path ?? "linear://", "not-applied");
      }
      context.signal?.throwIfAborted();
      if (Buffer.byteLength(input.content, "utf8") > 2 * 1024 * 1024) {
        throw new ResourceError("LINEAR_CONTENT_TOO_LARGE", address.source, "not-applied");
      }
      let created: CreatedLinearText;
      try {
        created = await create(address, input.content, context.cwd, context.signal);
      } catch (error) {
        const failure =
          error && typeof error === "object"
            ? (error as { message?: unknown; effect?: unknown })
            : undefined;
        const code =
          error instanceof ResourceError
            ? error.code
            : typeof failure?.message === "string" && /^LINEAR_[A-Z_]+$/u.test(failure.message)
              ? failure.message
              : "LINEAR_CREATE_FAILED";
        const effect = failure?.effect;
        throw linearResourceError(
          code,
          address.source,
          effect === "not-applied" || effect === "applied" ? effect : "unknown",
          linearErrorRateLimit(error),
        );
      }
      try {
        checkedReceipt(created, address);
      } catch {
        // Creation was acknowledged; a bad receipt must not invite a duplicate retry.
        throw new ResourceError("LINEAR_CREATION_RECEIPT_INVALID", address.source, "unknown");
      }
      const kind = address.kind === "create-document" ? "document" : "comment";
      return {
        source: created.source,
        script: { source: created.source },
        summary: `Created Linear ${kind}.\nURL: ${created.url}\n${kind === "document" ? "Content" : "Read"}: ${created.source}\nRead the returned resource before editing.`,
        data: {
          kind: `linear-${kind}-create`,
          effect: "applied",
          id: created.id,
          url: created.url,
          source: created.source,
        },
      };
    },
  };
}

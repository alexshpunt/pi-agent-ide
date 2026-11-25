import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FileOperationResolver } from "pi-agent-ide/api/text-editor";
import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import { isDocumentId } from "./urls.ts";
import { captureLinearJson } from "./json-read.ts";
import type {
  ArtifactFileInput,
  ArtifactReceipt,
  ArtifactTarget,
  LinearArtifactBackend,
} from "./artifact-backend.ts";

import type { LinearSemanticHandler as SemanticHandler } from "./semantic.ts";
export type ArtifactResource =
  | (Omit<ArtifactTarget, "kind"> & {
      readonly kind: "attachments";
      readonly parentKind: ArtifactTarget["kind"];
    })
  | {
      readonly kind: "attachment-file";
      readonly workspace: string;
      readonly identifier: string;
      readonly source: string;
      readonly issue?: string;
    };

function url(source: string): URL | undefined {
  let value: URL;
  try {
    value = new URL(source);
  } catch {
    return undefined;
  }
  if (value.protocol !== "linear:" && value.hostname !== "linear.app") return undefined;
  if (
    (value.protocol !== "linear:" && value.protocol !== "https:") ||
    value.username ||
    value.password ||
    value.port
  )
    throw new Error("LINEAR_INVALID_URL");
  return value;
}
function workspace(value: URL): string {
  const result = value.protocol === "linear:" ? value.hostname : value.pathname.split("/")[1];
  if (!result || !/^[A-Za-z0-9_-]+$/u.test(result)) throw new Error("LINEAR_INVALID_URL");
  return result;
}
/** Artifact fragments are transport resources, not byte-editable text documents. */
export function parseArtifactResource(source: string): ArtifactResource | undefined {
  const value = url(source);
  if (!value || !["#attachments", "#file"].includes(value.hash)) return undefined;
  const owner = workspace(value);
  if (value.hash === "#file") {
    const match =
      value.protocol === "linear:" ? /^\/attachment\/([^/]+)\/?$/u.exec(value.pathname) : undefined;
    if (
      !match ||
      !isDocumentId(match[1]) ||
      [...value.searchParams.keys()].some((key) => key !== "issue") ||
      value.searchParams.getAll("issue").length > 1
    )
      throw new Error("LINEAR_INVALID_URL");
    const issue = value.searchParams.get("issue");
    if (issue !== null && !/^[A-Z][A-Z0-9]*-\d+$/u.test(issue) && !isDocumentId(issue))
      throw new Error("LINEAR_INVALID_URL");
    return {
      kind: "attachment-file",
      workspace: owner,
      identifier: match[1].toLowerCase(),
      source: value.href,
      ...(issue ? { issue } : {}),
    };
  }
  const route =
    value.protocol === "linear:" ? value.pathname : value.pathname.replace(/^\/[^/]+/u, "");
  const issue = /^\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^/]+)?\/?$/u.exec(route);
  const project = /^\/project\/([^/]+)(?:\/overview)?\/?$/u.exec(route);
  const identifier = issue ? issue[1].toUpperCase() : project?.[1];
  if (
    identifier === undefined ||
    [...value.searchParams.keys()].some((key) => key !== "title") ||
    value.searchParams.getAll("title").length > 1
  )
    throw new Error("LINEAR_INVALID_URL");
  const title = value.searchParams.get("title");
  if (title !== null && (!title.trim() || title.length > 1000 || /[\u0000\r\n]/u.test(title)))
    throw new Error("LINEAR_INVALID_URL");
  return {
    kind: "attachments",
    parentKind: issue ? "issue" : "project",
    workspace: owner,
    identifier,
    source: value.href,
    ...(title ? { title } : {}),
  };
}
function documentReference(
  source: string,
): { workspace: string; identifier: string; title?: string } | undefined {
  const value = url(source);
  if (!value) return undefined;
  const route =
    value.protocol === "linear:" ? value.pathname : value.pathname.replace(/^\/[^/]+/u, "");
  const match = /^\/document\/([^/]+)(?:\/content)?\/?$/u.exec(route);
  if (!match) return undefined;
  const identifier = isDocumentId(match[1])
    ? match[1].toLowerCase()
    : value.protocol === "https:"
      ? /(?:^|-)([0-9a-f]{12})$/iu.exec(match[1])?.[1].toLowerCase()
      : undefined;
  if (
    !identifier ||
    value.hash ||
    [...value.searchParams.keys()].some((key) => key !== "title") ||
    value.searchParams.getAll("title").length > 1
  )
    throw new Error("LINEAR_INVALID_URL");
  const title = value.searchParams.get("title");
  return { workspace: workspace(value), identifier, ...(title !== null ? { title } : {}) };
}
function input(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
/** Accept a small typed file reference, never base64 or arbitrary replacement content. */
export function parseArtifactFileInput(value: string): ArtifactFileInput {
  if (value.length > 8192) throw new Error("LINEAR_FILE_REFERENCE_TOO_LARGE");
  if (value.startsWith("file:")) return { file: value };
  let result: Record<string, unknown> | undefined;
  try {
    result = input(JSON.parse(value));
  } catch {
    throw new Error("LINEAR_INVALID_FILE_REFERENCE");
  }
  if (
    !result ||
    Object.keys(result).some((key) => !["file", "title", "contentType", "issue"].includes(key)) ||
    typeof result.file !== "string" ||
    !result.file ||
    ["title", "contentType", "issue"].some(
      (key) => result[key] !== undefined && typeof result[key] !== "string",
    )
  )
    throw new Error("LINEAR_INVALID_FILE_REFERENCE");
  return {
    file: result.file,
    ...(typeof result.title === "string" ? { title: result.title } : {}),
    ...(typeof result.contentType === "string" ? { contentType: result.contentType } : {}),
    ...(typeof result.issue === "string" ? { issue: result.issue } : {}),
  };
}
function safeFailure(error: unknown): {
  code: string;
  effect: "applied" | "not-applied" | "unknown";
} {
  return error instanceof ResourceError
    ? { code: error.code, effect: error.effect }
    : {
        code:
          error instanceof Error && /^LINEAR_[A-Z_]+$/u.test(error.message)
            ? error.message
            : "LINEAR_ARTIFACT_FAILED",
        effect: "not-applied",
      };
}
function summary(receipt: ArtifactReceipt): string {
  return [
    `Linear artifact ${receipt.action}: ${receipt.effect}.`,
    `Read: ${receipt.source}`,
    ...(receipt.url ? [`URL: ${receipt.url}`] : []),
    ...(receipt.title ? [`Title: ${receipt.title}`] : []),
    ...(receipt.upload
      ? [
          `Upload: ${receipt.upload.upload} (${receipt.upload.size} bytes; SHA-256 ${receipt.upload.sha256})`,
          ...(receipt.upload.read ? [`Asset Read: ${receipt.upload.read}`] : []),
          ...(receipt.upload.attachment
            ? [
                `New attachment: ${receipt.upload.attachment.effect}${receipt.upload.attachment.id ? ` (${receipt.upload.attachment.id})` : ""}`,
              ]
            : []),
        ]
      : []),
    ...(receipt.removal
      ? [`Old attachment removal: ${receipt.removal.effect} (${receipt.removal.id})`]
      : []),
    ...(receipt.error
      ? [`Error: ${receipt.error}. Retain the completed phases; inspect before any retry.`]
      : []),
    ...(receipt.effect === "unknown"
      ? ["The result is uncertain. Do not replay this operation."]
      : []),
    "Read again before another change.",
  ].join("\n");
}

/** Read metadata only; ordinary text edits never mutate an attachment or its bytes. */
export function createLinearArtifactResolver(backend: LinearArtifactBackend): ResourceResolver {
  return {
    id: "linear-artifacts",
    async tryResolve(source, context) {
      let address: ArtifactResource | undefined;
      try {
        address = parseArtifactResource(source);
      } catch (error) {
        return {
          kind: "failed",
          error: new ResourceError(safeFailure(error).code, source, "not-applied"),
        };
      }
      if (!address) return { kind: "not-handled" };
      return {
        kind: "resolved",
        resource: {
          source: address.source,
          link: address.source,
          async read(operation) {
            try {
              return await captureLinearJson((capture) =>
                address.kind === "attachments"
                  ? backend.describeAttachments(
                      { ...address, kind: address.parentKind },
                      context.cwd,
                      operation.signal,
                      capture,
                    )
                  : backend.describeAttachment(
                      address.workspace,
                      address.identifier,
                      address.issue,
                      context.cwd,
                      operation.signal,
                      capture,
                    ),
              );
            } catch (error) {
              throw new ResourceError(safeFailure(error).code, address.source, "not-applied");
            }
          },
        },
      };
    },
  };
}
/** Wire whole-document rename/link and typed file transport into existing editor tools. */
export function createLinearArtifactHandlers(backend: LinearArtifactBackend): {
  readonly fileOperations: FileOperationResolver;
  readonly insert: SemanticHandler;
  readonly write: SemanticHandler;
} {
  const fileOperations: FileOperationResolver = async (operation, value, context) => {
    let owned = false;
    try {
      if (operation === "move") {
        const original = documentReference(value.path);
        if (!original) return undefined;
        owned = true;
        const target = value.target ? documentReference(value.target) : undefined;
        if (
          !target?.title ||
          original.title !== undefined ||
          target.workspace !== original.workspace ||
          (isDocumentId(target.identifier) === isDocumentId(original.identifier) &&
            target.identifier !== original.identifier)
        )
          throw new Error("LINEAR_INVALID_DOCUMENT_RENAME");
        const receipt = await backend.rename(
          original.workspace,
          original.identifier,
          target.title,
          context.cwd,
          context.signal,
          target.identifier,
        );
        return {
          kind: "file-operation",
          operation,
          ok: true,
          effect: receipt.effect,
          path: receipt.source,
          target: receipt.source,
          sourceKind: "file",
        };
      }
      if (operation === "copy") {
        const target = value.target && parseArtifactResource(value.target);
        if (!target || target.kind !== "attachments") return undefined;
        owned = true;
        const receipt = await backend.link(
          { ...target, kind: target.parentKind },
          value.path,
          context.cwd,
          context.signal,
        );
        return {
          kind: "file-operation",
          operation,
          ok: true,
          effect: receipt.effect,
          path: value.path,
          target: receipt.source,
          sourceKind: "file",
        };
      }
      return undefined;
    } catch (error) {
      if (
        !owned &&
        !value.path.startsWith("linear:") &&
        !value.target?.startsWith("linear:") &&
        !value.target?.includes("linear.app/")
      )
        return undefined;
      const failed = safeFailure(error);
      return {
        kind: "file-operation",
        operation,
        ok: false,
        effect: failed.effect,
        path: value.path,
        ...(value.target ? { target: value.target } : {}),
        error: { code: failed.code, message: failed.code },
      };
    }
  };
  const insert: SemanticHandler = {
    matches(value) {
      const parameters = input(value);
      return (
        typeof parameters?.path === "string" &&
        parseArtifactResource(parameters.path)?.kind === "attachments"
      );
    },
    async execute(context, value) {
      const parameters = input(value);
      const address =
        typeof parameters?.path === "string" ? parseArtifactResource(parameters.path) : undefined;
      if (
        !parameters ||
        address?.kind !== "attachments" ||
        typeof parameters.text !== "string" ||
        (parameters.after !== undefined && parameters.after !== "end") ||
        parameters.before !== undefined
      )
        throw new ResourceError(
          "LINEAR_INVALID_ATTACHMENT_INSERT",
          typeof parameters?.path === "string" ? parameters.path : "linear://",
          "not-applied",
        );
      const receipt = await backend.insert(
        { ...address, kind: address.parentKind },
        parseArtifactFileInput(parameters.text),
        context.cwd,
        context.signal,
      );
      return { source: receipt.source, summary: summary(receipt), data: receipt };
    },
  };
  const write: SemanticHandler = {
    matches(value) {
      const parameters = input(value);
      return (
        typeof parameters?.path === "string" &&
        parseArtifactResource(parameters.path)?.kind === "attachment-file"
      );
    },
    async execute(context, value) {
      const parameters = input(value);
      const address =
        typeof parameters?.path === "string" ? parseArtifactResource(parameters.path) : undefined;
      if (
        !parameters ||
        address?.kind !== "attachment-file" ||
        typeof parameters.content !== "string"
      )
        throw new ResourceError(
          "LINEAR_INVALID_ATTACHMENT_WRITE",
          typeof parameters?.path === "string" ? parameters.path : "linear://",
          "not-applied",
        );
      const file = parseArtifactFileInput(parameters.content);
      if (address.issue && file.issue && address.issue !== file.issue)
        throw new ResourceError("LINEAR_IDENTITY_MISMATCH", address.source, "not-applied");
      const receipt = await backend.replace(
        address.workspace,
        address.identifier,
        { ...file, ...(address.issue ? { issue: address.issue } : {}) },
        context.cwd,
        context.signal,
        context.sourceDocument.content,
      );
      return { source: receipt.source, summary: summary(receipt), data: receipt };
    },
  };
  return { fileOperations, insert, write };
}

/** Keep canonical links and partial phase receipts visible even after host result compaction. */
export function connectLinearArtifactReceipts(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (!["write", "insert"].includes(event.toolName)) return;
    const details = input(event.details);
    const metadata = input(details?.metadata);
    const receipt = input(metadata?.semanticAction);
    if (
      !receipt ||
      receipt.kind !== "linear-artifact-action" ||
      !["upload", "replace"].includes(String(receipt.action)) ||
      !["applied", "not-applied", "unknown"].includes(String(receipt.effect)) ||
      typeof receipt.source !== "string" ||
      !receipt.source.startsWith("linear://")
    )
      return;
    const artifact = receipt as ArtifactReceipt;
    return {
      content: [
        ...(artifact.error ? [] : event.content),
        { type: "text" as const, text: summary(artifact) },
      ],
      isError:
        event.isError ||
        artifact.effect !== "applied" ||
        artifact.error !== undefined ||
        artifact.upload?.attachment?.effect !== "applied",
      ...(event.structuredContent === undefined
        ? {}
        : { structuredContent: event.structuredContent }),
    };
  });
}

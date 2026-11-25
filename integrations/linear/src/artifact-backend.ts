import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResourceError } from "pi-agent-ide/api/resource";
import { createAxiUploader, type LinearUploadReceipt } from "./upload.ts";
import { createLinearAssetResolver } from "./asset-read.ts";
import { assetAddress, checkedAssetUrl, parseAssetAddress } from "./asset-address.ts";
import { isDocumentId, parseDocumentUrl, parseIssueUrl } from "./urls.ts";
import type { LinearJsonCapture } from "./json-read.ts";

function describeJson(value: unknown, capture?: LinearJsonCapture): string {
  capture?.(value);
  return JSON.stringify(value, null, 2);
}

export type ArtifactEffect = "applied" | "not-applied" | "unknown";
/** The backend keeps authorization and validates its fixed operation catalog. */
export interface ArtifactOperationBackend {
  invoke(
    workspace: string,
    operation: string,
    input: Record<string, unknown>,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<{
    readonly workspace: string;
    readonly operation: string;
    readonly effect: ArtifactEffect;
    readonly data?: unknown;
    readonly error?: string;
  }>;
}
/** A verified issue attachment or project resource collection. */
export interface ArtifactTarget {
  readonly workspace: string;
  readonly kind: "issue" | "project";
  readonly identifier: string;
  readonly source: string;
  readonly title?: string;
}
/** A file reference is transport input, never the literal contents of a document. */
export interface ArtifactFileInput {
  readonly file: string;
  readonly title?: string;
  readonly contentType?: string;
  /** Required when the attachment API does not expose its issue parent. */
  readonly issue?: string;
}
export type ArtifactReceipt = {
  readonly kind: "linear-artifact-action";
  readonly action: "rename" | "link" | "upload" | "replace";
  readonly effect: ArtifactEffect;
  readonly source: string;
  readonly id?: string;
  readonly url?: string;
  readonly title?: string;
  readonly error?: string;
  readonly upload?: LinearUploadReceipt;
  readonly oldAssetUrl?: string;
  readonly removal?: {
    readonly effect: ArtifactEffect;
    readonly id: string;
    readonly error?: string;
  };
};
export interface ArtifactBackendOptions {
  readonly upload?: ReturnType<typeof createAxiUploader>;
  readonly readBytes?: (source: string, cwd: string, signal?: AbortSignal) => Promise<Uint8Array>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("LINEAR_INVALID_RESPONSE");
  return value as Record<string, unknown>;
}
function dataRow(value: unknown, kind: string): Record<string, unknown> {
  const root = object(value);
  return root[kind] && typeof root[kind] === "object" ? object(root[kind]) : root;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("LINEAR_INVALID_RESPONSE");
  return value;
}
function code(error: unknown, fallback = "LINEAR_ARTIFACT_FAILED"): string {
  return error instanceof ResourceError
    ? error.code
    : error instanceof Error && /^LINEAR_[A-Z_]+$/u.test(error.message)
      ? error.message
      : fallback;
}
function failure(error: unknown, source: string, effect: ArtifactEffect): ResourceError {
  return new ResourceError(
    code(error),
    source,
    error instanceof ResourceError ? error.effect : effect,
  );
}
/** Remove only transient signing data from the documented private host, never from external URLs. */
function stableLink(value: unknown): string {
  const url = new URL(text(value));
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error("LINEAR_INVALID_ARTIFACT_URL");
  if (url.hostname === "uploads.linear.app") {
    url.search = "";
    url.hash = "";
    return checkedAssetUrl(url.href);
  }
  return url.href;
}
function parentSnapshot(row: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      ["issueId", "projectId", "teamId", "initiativeId", "cycleId", "issue", "project", "team"]
        .filter((key) => row[key] !== undefined)
        .map((key) => [key, row[key]]),
    ),
  );
}
function documentSource(workspace: string, id: string): string {
  return `linear://${workspace}/document/${id.toLowerCase()}`;
}
function localFile(value: string): string {
  if (value.startsWith("file://")) return fileURLToPath(value);
  const file = value.startsWith("file:") ? value.slice(5) : value;
  if (!file || file.includes("://") || /[\u0000\r\n]/u.test(file))
    throw new Error("LINEAR_INVALID_FILE_REFERENCE");
  return file;
}
async function defaultReadBytes(
  source: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const result = await createLinearAssetResolver().tryResolve(source, { cwd, signal });
  if (result.kind !== "resolved" || !result.resource.readBytes)
    throw new Error("LINEAR_ASSET_SNAPSHOT_UNVERIFIED");
  return (await result.resource.readBytes(0, undefined, { signal })).bytes;
}

/** Artifact changes preserve completed phases and never compensate or repeat an uncertain effect. */
export function createLinearArtifactBackend(
  operations: ArtifactOperationBackend,
  options: ArtifactBackendOptions = {},
) {
  const upload = options.upload ?? createAxiUploader();
  const readBytes = options.readBytes ?? defaultReadBytes;
  async function invoke(
    workspace: string,
    operation: string,
    input: Record<string, unknown>,
    cwd: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const receipt = await operations.invoke(workspace, operation, input, cwd, signal);
    if (
      receipt.workspace !== workspace ||
      receipt.operation !== operation ||
      !["applied", "not-applied", "unknown"].includes(receipt.effect)
    )
      throw new ResourceError(
        "LINEAR_INVALID_OPERATION_RECEIPT",
        `linear://${workspace}`,
        "unknown",
      );
    if (receipt.effect !== "applied" || receipt.error)
      throw new ResourceError(
        receipt.error && /^LINEAR_[A-Z_]+$/u.test(receipt.error)
          ? receipt.error
          : "LINEAR_ARTIFACT_FAILED",
        `linear://${workspace}`,
        receipt.effect,
      );
    return receipt.data;
  }
  async function issue(workspace: string, identifier: string, cwd: string, signal?: AbortSignal) {
    const row = dataRow(
      await invoke(workspace, "get_issue", { id: identifier }, cwd, signal),
      "issue",
    );
    const url = parseIssueUrl(text(row.url));
    const uuid = isDocumentId(String(row.uuid))
      ? String(row.uuid)
      : isDocumentId(String(row.id))
        ? String(row.id)
        : undefined;
    if (
      !url ||
      url.workspace !== workspace ||
      (isDocumentId(identifier)
        ? uuid !== identifier
        : url.identifier.toUpperCase() !== identifier.toUpperCase())
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    if (!Array.isArray(row.attachments)) throw new Error("LINEAR_ATTACHMENT_LIST_UNAVAILABLE");
    return {
      row,
      identifier: url.identifier.toUpperCase(),
      uuid,
      url: url.source,
      attachments: row.attachments.map(object),
    };
  }
  async function project(workspace: string, identifier: string, cwd: string, signal?: AbortSignal) {
    const row = dataRow(
      await invoke(
        workspace,
        "get_project",
        { query: identifier, includeResources: true },
        cwd,
        signal,
      ),
      "project",
    );
    const url = new URL(text(row.url));
    const route = /^\/([^/]+)\/project\/([^/]+)(?:\/overview)?\/?$/u.exec(url.pathname);
    const uuid = isDocumentId(String(row.uuid))
      ? String(row.uuid).toLowerCase()
      : isDocumentId(String(row.id))
        ? String(row.id).toLowerCase()
        : undefined;
    if (
      url.protocol !== "https:" ||
      url.hostname !== "linear.app" ||
      url.username ||
      url.password ||
      url.port ||
      !route ||
      route[1] !== workspace ||
      !uuid ||
      (isDocumentId(identifier)
        ? identifier.toLowerCase() !== uuid
        : identifier !== route[2] && identifier !== row.id)
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    const returnedResources = row.resources ?? (row.resourceCount === 0 ? [] : undefined);
    if (
      !Array.isArray(returnedResources) ||
      (row.resourceCount !== undefined && row.resourceCount !== returnedResources.length)
    )
      throw new Error("LINEAR_ATTACHMENT_LIST_UNAVAILABLE");
    const resources = returnedResources.map<Record<string, unknown>>((value) => {
      const item = object(value);
      stableLink(item.url);
      return { ...item, title: text(item.title ?? item.label) };
    });
    return { row, uuid, resources, source: `linear://${workspace}/project/${uuid}#attachments` };
  }
  async function linkProject(
    target: ArtifactTarget,
    source: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ArtifactReceipt> {
    let dispatched = false;
    let acknowledged = false;
    try {
      const parent = await project(target.workspace, target.identifier, cwd, signal);
      const item = await existingLink(target.workspace, source, cwd, signal);
      const title = target.title ?? item.title;
      if (!title.trim() || title.length > 1000 || /[\u0000\r\n]/u.test(title))
        throw new Error("LINEAR_INVALID_ATTACHMENT_TITLE");
      const existing = parent.resources.find((row) => stableLink(row.url) === item.url);
      if (existing)
        return {
          kind: "linear-artifact-action",
          action: "link",
          effect: "applied",
          source: parent.source,
          ...(typeof existing.id === "string" ? { id: existing.id } : {}),
          url: item.url,
          title: text(existing.title),
        };
      dispatched = true;
      await invoke(
        target.workspace,
        "save_project",
        { id: parent.uuid, links: [{ url: item.url, title }] },
        cwd,
        signal,
      );
      acknowledged = true;
      const saved = await project(target.workspace, parent.uuid, cwd, signal);
      const attached = saved.resources.find(
        (row) => stableLink(row.url) === item.url && row.title === title,
      );
      if (
        !attached ||
        parent.resources.some(
          (old) =>
            !saved.resources.some(
              (row) => stableLink(row.url) === stableLink(old.url) && row.title === old.title,
            ),
        )
      )
        throw new Error("LINEAR_ATTACHMENT_UNVERIFIED");
      return {
        kind: "linear-artifact-action",
        action: "link",
        effect: "applied",
        source: saved.source,
        ...(typeof attached.id === "string" ? { id: attached.id } : {}),
        url: item.url,
        title,
      };
    } catch (error) {
      throw acknowledged
        ? new ResourceError(code(error), target.source, "unknown")
        : failure(error, target.source, dispatched ? "unknown" : "not-applied");
    }
  }
  async function document(
    workspace: string,
    identifier: string,
    cwd: string,
    signal?: AbortSignal,
  ) {
    const row = dataRow(
      await invoke(workspace, "get_document", { id: identifier }, cwd, signal),
      "document",
    );
    const id = text(row.id).toLowerCase();
    const url = parseDocumentUrl(text(row.url));
    if (
      !isDocumentId(id) ||
      !url?.native ||
      url.workspace !== workspace ||
      (isDocumentId(identifier)
        ? identifier.toLowerCase() !== id
        : identifier.toLowerCase() !== url.identifier)
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    text(row.title);
    if (row.content != null && typeof row.content !== "string")
      throw new Error("LINEAR_INVALID_RESPONSE");
    return { row, id, url: url.source };
  }
  async function existingLink(
    workspace: string,
    source: string,
    cwd: string,
    signal?: AbortSignal,
  ) {
    const url = new URL(source);
    if (url.protocol === "linear:" && url.hostname !== workspace)
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    const asset = parseAssetAddress(source);
    if (asset)
      return {
        url: asset.url,
        title: path.posix.basename(new URL(asset.url).pathname) || "Linked file",
      };
    const attachment =
      url.protocol === "linear:" ? /^\/attachment\/([^/]+)\/?$/u.exec(url.pathname) : undefined;
    if (attachment) {
      if (
        !isDocumentId(attachment[1]) ||
        (url.hash && url.hash !== "#file") ||
        [...url.searchParams.keys()].some((key) => key !== "issue")
      )
        throw new Error("LINEAR_INVALID_ARTIFACT_URL");
      const row = dataRow(
        await invoke(
          workspace,
          "get_attachment",
          { id: attachment[1], format: "url" },
          cwd,
          signal,
        ),
        "attachment",
      );
      if (row.id !== attachment[1]) throw new Error("LINEAR_IDENTITY_MISMATCH");
      return { url: stableLink(row.url), title: text(row.title) };
    }
    const isDocument =
      url.protocol === "linear:"
        ? url.pathname.startsWith("/document/")
        : url.hostname === "linear.app" && /^\/[^/]+\/document\//u.test(url.pathname);
    if (isDocument) {
      const address = new URL(source);
      if (address.pathname.endsWith("/content")) address.pathname = address.pathname.slice(0, -8);
      const parsed = parseDocumentUrl(address.href);
      if (!parsed || parsed.workspace !== workspace) throw new Error("LINEAR_IDENTITY_MISMATCH");
      const result = await document(workspace, parsed.identifier, cwd, signal);
      return { url: result.url, title: text(result.row.title) };
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      throw new Error("LINEAR_INVALID_ARTIFACT_URL");
    if (url.hostname === "linear.app" && url.pathname.split("/")[1] !== workspace)
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    return {
      url: stableLink(url.href),
      title: decodeURIComponent(path.posix.basename(url.pathname)) || "Linked resource",
    };
  }
  async function describeAttachments(
    target: ArtifactTarget,
    cwd: string,
    signal?: AbortSignal,
    capture?: LinearJsonCapture,
  ): Promise<string> {
    if (target.kind === "project") {
      const parent = await project(target.workspace, target.identifier, cwd, signal);
      return describeJson(
        {
          project: parent.uuid,
          source: parent.source,
          resources: parent.resources.map((row) => {
            const url = stableLink(row.url);
            return {
              ...(typeof row.id === "string" ? { id: row.id } : {}),
              title: text(row.title),
              url,
              read:
                new URL(url).hostname === "uploads.linear.app"
                  ? assetAddress(target.workspace, url)
                  : url,
            };
          }),
        },
        capture,
      );
    }
    const parent = await issue(target.workspace, target.identifier, cwd, signal);
    return describeJson(
      {
        issue: parent.identifier,
        attachments: parent.attachments.map((row) => {
          const id = text(row.id);
          if (!isDocumentId(id)) throw new Error("LINEAR_INVALID_RESPONSE");
          const url = stableLink(row.url);
          return {
            id,
            title: text(row.title),
            url,
            source: `linear://${target.workspace}/attachment/${id}?issue=${parent.identifier}#file`,
            ...(new URL(url).hostname === "uploads.linear.app"
              ? { read: assetAddress(target.workspace, url) }
              : {}),
          };
        }),
      },
      capture,
    );
  }
  async function describeAttachment(
    workspace: string,
    id: string,
    parentIdentifier: string | undefined,
    cwd: string,
    signal?: AbortSignal,
    capture?: LinearJsonCapture,
  ): Promise<string> {
    if (!isDocumentId(id)) throw new Error("LINEAR_INVALID_ATTACHMENT_ID");
    const row = dataRow(
      await invoke(workspace, "get_attachment", { id, format: "url" }, cwd, signal),
      "attachment",
    );
    if (row.id !== id) throw new Error("LINEAR_IDENTITY_MISMATCH");
    const url = stableLink(row.url);
    const declaredParent = typeof row.issueId === "string" ? row.issueId : parentIdentifier;
    let parent: string | undefined;
    if (declaredParent) {
      const owner = await issue(workspace, declaredParent, cwd, signal);
      if (!owner.attachments.some((item) => item.id === id && stableLink(item.url) === url))
        throw new Error("LINEAR_IDENTITY_MISMATCH");
      parent = owner.identifier;
    }
    return describeJson(
      {
        id,
        title: text(row.title),
        url,
        ...(parent ? { issue: parent } : {}),
        ...(new URL(url).hostname === "uploads.linear.app"
          ? { read: assetAddress(workspace, url) }
          : {}),
      },
      capture,
    );
  }
  async function rename(
    workspace: string,
    identifier: string,
    title: string,
    cwd: string,
    signal?: AbortSignal,
    expectedIdentifier?: string,
  ): Promise<ArtifactReceipt> {
    const source = documentSource(workspace, identifier);
    let dispatched = false;
    let acknowledged = false;
    try {
      if (!title.trim() || title.length > 1000 || /[\u0000-\u001f\u007f]/u.test(title))
        throw new Error("LINEAR_INVALID_DOCUMENT_TITLE");
      const before = await document(workspace, identifier, cwd, signal);
      if (
        expectedIdentifier &&
        expectedIdentifier !== before.id &&
        expectedIdentifier !== parseDocumentUrl(before.url)?.identifier
      )
        throw new Error("LINEAR_INVALID_DOCUMENT_RENAME");
      if (before.row.title !== title) {
        dispatched = true;
        await invoke(workspace, "save_document", { id: before.id, title }, cwd, signal);
        acknowledged = true;
      }
      const saved = await document(workspace, before.id, cwd, signal);
      if (
        saved.row.title !== title ||
        saved.row.content !== before.row.content ||
        parentSnapshot(saved.row) !== parentSnapshot(before.row)
      )
        throw new Error("LINEAR_RENAME_UNVERIFIED");
      return {
        kind: "linear-artifact-action",
        action: "rename",
        effect: "applied",
        source: documentSource(workspace, before.id),
        id: before.id,
        title,
        url: saved.url,
      };
    } catch (error) {
      throw acknowledged
        ? new ResourceError(code(error), source, "unknown")
        : failure(error, source, dispatched ? "unknown" : "not-applied");
    }
  }
  async function link(
    target: ArtifactTarget,
    source: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ArtifactReceipt> {
    if (target.kind === "project") return linkProject(target, source, cwd, signal);
    let dispatched = false;
    let acknowledged = false;
    try {
      const parent = await issue(target.workspace, target.identifier, cwd, signal);
      const item = await existingLink(target.workspace, source, cwd, signal);
      const title = target.title ?? item.title;
      if (!title.trim() || title.length > 1000 || /[\u0000\r\n]/u.test(title))
        throw new Error("LINEAR_INVALID_ATTACHMENT_TITLE");
      const existing = parent.attachments.find((row) => stableLink(row.url) === item.url);
      if (existing)
        return {
          kind: "linear-artifact-action",
          action: "link",
          effect: "applied",
          source: target.source,
          id: text(existing.id),
          url: item.url,
          title: text(existing.title),
        };
      dispatched = true;
      await invoke(
        target.workspace,
        "save_issue",
        { id: parent.identifier, links: [{ url: item.url, title }] },
        cwd,
        signal,
      );
      acknowledged = true;
      const saved = await issue(target.workspace, parent.identifier, cwd, signal);
      const attached = saved.attachments.find(
        (row) => stableLink(row.url) === item.url && row.title === title,
      );
      if (!attached) throw new Error("LINEAR_ATTACHMENT_UNVERIFIED");
      return {
        kind: "linear-artifact-action",
        action: "link",
        effect: "applied",
        source: target.source,
        id: text(attached.id),
        url: item.url,
        title,
      };
    } catch (error) {
      throw acknowledged
        ? new ResourceError(code(error), target.source, "unknown")
        : failure(error, target.source, dispatched ? "unknown" : "not-applied");
    }
  }
  async function insert(
    target: ArtifactTarget,
    input: ArtifactFileInput,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ArtifactReceipt> {
    let dispatched = false;
    try {
      if (target.kind !== "issue") throw new Error("LINEAR_ATTACHMENT_PARENT_UNSUPPORTED");
      const parent = await issue(target.workspace, target.identifier, cwd, signal);
      if (input.issue && input.issue !== parent.identifier && input.issue !== parent.uuid)
        throw new Error("LINEAR_IDENTITY_MISMATCH");
      const file = localFile(input.file);
      dispatched = true;
      const uploaded = await upload(
        {
          file,
          workspace: target.workspace,
          issue: parent.identifier,
          ...(input.title ? { title: input.title } : {}),
          ...(input.contentType ? { contentType: input.contentType } : {}),
        },
        cwd,
        signal,
      );
      const effect =
        uploaded.upload === "unknown" || uploaded.attachment?.effect === "unknown"
          ? "unknown"
          : uploaded.upload;
      return {
        kind: "linear-artifact-action",
        action: "upload",
        effect,
        source: target.source,
        upload: uploaded,
        ...(uploaded.error || uploaded.attachment?.error
          ? { error: uploaded.error ?? uploaded.attachment?.error }
          : {}),
      };
    } catch (error) {
      throw failure(error, target.source, dispatched ? "unknown" : "not-applied");
    }
  }
  async function replace(
    workspace: string,
    attachmentId: string,
    input: ArtifactFileInput,
    cwd: string,
    signal?: AbortSignal,
    expectedContent?: string,
  ): Promise<ArtifactReceipt> {
    const source = `linear://${workspace}/attachment/${attachmentId}#file`;
    let uploaded: LinearUploadReceipt | undefined;
    let uploadDispatched = false;
    let replacementSource = source;
    let replacementId: string | undefined;
    let removalAcknowledged = false;
    let removal: ArtifactReceipt["removal"] = { effect: "not-applied", id: attachmentId };
    let oldAssetUrl: string | undefined;
    try {
      if (!isDocumentId(attachmentId)) throw new Error("LINEAR_INVALID_ATTACHMENT_ID");
      const old = dataRow(
        await invoke(workspace, "get_attachment", { id: attachmentId, format: "url" }, cwd, signal),
        "attachment",
      );
      if (old.id !== attachmentId) throw new Error("LINEAR_IDENTITY_MISMATCH");
      oldAssetUrl = stableLink(old.url);
      const declaredParent = typeof old.issueId === "string" ? old.issueId : input.issue;
      if (!declaredParent) throw new Error("LINEAR_ATTACHMENT_PARENT_REQUIRED");
      const parent = await issue(workspace, declaredParent, cwd, signal);
      if (input.issue && input.issue !== parent.identifier && input.issue !== parent.uuid)
        throw new Error("LINEAR_IDENTITY_MISMATCH");
      const oldLink = parent.attachments.find((row) => row.id === attachmentId);
      if (!oldLink || stableLink(oldLink.url) !== oldAssetUrl)
        throw new Error("LINEAR_IDENTITY_MISMATCH");
      const oldTitle = text(oldLink.title);
      if (expectedContent !== undefined) {
        const expected = object(JSON.parse(expectedContent));
        if (
          expected.id !== attachmentId ||
          expected.title !== oldTitle ||
          stableLink(expected.url) !== oldAssetUrl ||
          (expected.issue !== undefined && expected.issue !== parent.identifier)
        )
          throw new Error("LINEAR_STALE_ATTACHMENT");
      }
      const file = localFile(input.file);
      uploadDispatched = true;
      uploaded = await upload(
        {
          file,
          workspace,
          issue: parent.identifier,
          title: input.title ?? oldTitle,
          ...(input.contentType ? { contentType: input.contentType } : {}),
        },
        cwd,
        signal,
      );
      if (
        uploaded.upload !== "applied" ||
        uploaded.attachment?.effect !== "applied" ||
        uploaded.error ||
        uploaded.attachment.error
      ) {
        return {
          kind: "linear-artifact-action",
          action: "replace",
          source,
          effect:
            uploaded.upload === "unknown" || uploaded.attachment?.effect === "unknown"
              ? "unknown"
              : uploaded.upload,
          upload: uploaded,
          oldAssetUrl,
          removal,
          error: uploaded.error ?? uploaded.attachment?.error ?? "LINEAR_REPLACEMENT_INCOMPLETE",
        };
      }
      if (
        !uploaded.read ||
        !uploaded.assetUrl ||
        !uploaded.attachment.id ||
        !isDocumentId(uploaded.attachment.id) ||
        uploaded.attachment.id === attachmentId
      )
        throw new Error("LINEAR_REPLACEMENT_UNVERIFIED");
      const newId = uploaded.attachment.id;
      const newAssetUrl = uploaded.assetUrl;
      replacementId = newId;
      replacementSource = `linear://${workspace}/attachment/${replacementId}?issue=${parent.identifier}#file`;
      const payload = await readBytes(uploaded.read, cwd, signal);
      if (
        payload.byteLength !== uploaded.size ||
        createHash("sha256").update(payload).digest("hex") !== uploaded.sha256
      )
        throw new Error("LINEAR_ASSET_SNAPSHOT_UNVERIFIED");
      let verified = false;
      // Only observation is repeated: upload and removal each remain a single dispatch.
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await issue(workspace, parent.identifier, cwd, signal);
        const unchanged = current.attachments.find((row) => row.id === attachmentId);
        const replacement = current.attachments.find((row) => row.id === newId);
        if (!unchanged || stableLink(unchanged.url) !== oldAssetUrl || unchanged.title !== oldTitle)
          throw new Error("LINEAR_STALE_ATTACHMENT");
        if (!replacement) continue;
        if (stableLink(replacement.url) !== newAssetUrl)
          throw new Error("LINEAR_REPLACEMENT_URL_MISMATCH");
        verified = true;
        break;
      }
      if (!verified) throw new Error("LINEAR_REPLACEMENT_NOT_VISIBLE");
      signal?.throwIfAborted();
      removal = { effect: "unknown", id: attachmentId };
      await invoke(workspace, "delete_attachment", { id: attachmentId }, cwd, signal);
      removalAcknowledged = true;
      const removed = await issue(workspace, parent.identifier, cwd, signal);
      if (
        removed.attachments.some((row) => row.id === attachmentId) ||
        !removed.attachments.some((row) => row.id === newId && stableLink(row.url) === newAssetUrl)
      )
        throw new Error("LINEAR_REMOVAL_UNVERIFIED");
      removal = { effect: "applied", id: attachmentId };
      return {
        kind: "linear-artifact-action",
        action: "replace",
        effect: "applied",
        source: replacementSource,
        id: replacementId,
        url: uploaded.assetUrl,
        upload: uploaded,
        oldAssetUrl,
        removal,
      };
    } catch (error) {
      if (!uploaded) throw failure(error, source, uploadDispatched ? "unknown" : "not-applied");
      if (
        !removalAcknowledged &&
        removal.effect === "unknown" &&
        error instanceof ResourceError &&
        error.effect === "not-applied"
      )
        removal = { effect: "not-applied", id: attachmentId, error: code(error) };
      return {
        kind: "linear-artifact-action",
        action: "replace",
        effect: "unknown",
        source: replacementSource,
        ...(replacementId ? { id: replacementId } : {}),
        ...(uploaded.assetUrl ? { url: uploaded.assetUrl } : {}),
        upload: uploaded,
        ...(oldAssetUrl ? { oldAssetUrl } : {}),
        removal: { ...removal, error: code(error) },
        error: code(error),
      };
    }
  }
  return { rename, link, insert, replace, describeAttachments, describeAttachment };
}
export type LinearArtifactBackend = ReturnType<typeof createLinearArtifactBackend>;

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResourceError } from "pi-agent-ide/api/resource";
import { decode } from "@toon-format/toon-v4";
import { decodeAxiObject, decodeDocument, decodeIssue, runAxi } from "./axi.ts";
import { parsePageUrl, isDocumentId } from "./urls.ts";
import type { LinearTextAddress } from "./text-address.ts";
import type { CreatedLinearText, LinearTextCreator } from "./text-create.ts";
import { stableLinearAssetLinks } from "./asset-links.ts";
import { linearErrorRateLimit, linearResourceError } from "./resource-failure.ts";

export type LinearBodyAddress = Extract<
  LinearTextAddress,
  { readonly kind: "document-content" | "issue-description" | "project-description" }
>;
export interface LinearBody {
  readonly content: string;
  readonly url: string;
}

/** AXI owns the remote authorization; this adapter owns temporary text transport and freshness checks. */
export function createLinearTextBackend(run: typeof runAxi = runAxi) {
  async function read(
    address: LinearBodyAddress,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<LinearBody> {
    signal?.throwIfAborted();
    if (address.kind === "document-content") {
      const source = `linear://${address.workspace}/document/${address.identifier}`;
      const document = decodeDocument(
        await run(cwd, ["documents", "view", address.identifier, "--full"], signal),
        source,
      );
      return { content: stableLinearAssetLinks(document.content), url: document.url };
    }
    if (address.kind === "issue-description") {
      const source = `https://linear.app/${address.workspace}/issue/${address.identifier}`;
      const issue = decodeIssue(
        await run(cwd, ["issues", "view", address.identifier, "--full"], signal),
        source,
      );
      return { content: stableLinearAssetLinks(issue.description), url: issue.url };
    }
    const output = await run(cwd, ["projects", "view", address.identifier, "--full"], signal);
    const project = decodeAxiObject(output, "project", [
      "id",
      "uuid",
      "url",
      "description",
    ]).project;
    if (!project || typeof project !== "object" || Array.isArray(project))
      throw new Error("LINEAR_INVALID_RESPONSE");
    const row = project as Record<string, unknown>;
    const page = typeof row.url === "string" ? parsePageUrl(row.url) : undefined;
    if (
      page?.kind !== "project" ||
      page.workspace !== address.workspace ||
      row.uuid !== address.identifier
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    if (row.description != null && typeof row.description !== "string")
      throw new Error("LINEAR_INVALID_RESPONSE");
    return {
      content: stableLinearAssetLinks(typeof row.description === "string" ? row.description : ""),
      url: page.source,
    };
  }

  async function readComment(
    source: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<LinearBody> {
    const url = new URL(source);
    const match = /^\/issue\/([A-Z][A-Z0-9]*-\d+)\/comment\/([0-9a-f-]{36})$/u.exec(url.pathname);
    if (
      url.protocol !== "linear:" ||
      !match ||
      !isDocumentId(match[2]) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      url.port
    )
      throw new Error("LINEAR_INVALID_URL");
    const parent: LinearBodyAddress = {
      kind: "issue-description",
      workspace: url.hostname,
      identifier: match[1],
      source: `linear://${url.hostname}/issue/${match[1]}/description`,
    };
    // The parent check and the comment lookup are independent requests; run them together.
    // A parent failure still takes precedence over a lookup failure.
    const [issue, body] = await Promise.allSettled([
      read(parent, cwd, signal),
      findComment(match[1], match[2], cwd, signal),
    ]);
    if (issue.status === "rejected") throw issue.reason;
    if (body.status === "rejected") throw body.reason;
    return { content: body.value, url: issue.value.url };
  }
  async function findComment(
    identifier: string,
    id: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page++) {
      const output = await run(
        cwd,
        [
          "comments",
          "list",
          "--issue",
          identifier,
          "--limit",
          "50",
          "--full",
          ...(cursor ? ["--cursor", cursor] : []),
        ],
        signal,
      );
      const value = decode(
        output
          .split(/\n(?=\S)/u)
          .filter((chunk) => /^(?:comments[[:]|count:|cursor:)/u.test(chunk))
          .join("\n"),
      ) as Record<string, unknown>;
      // Full MCP lists may wrap the rows and pagination inside the named collection.
      const collection = value.comments;
      const envelope =
        collection && typeof collection === "object" && !Array.isArray(collection)
          ? (collection as Record<string, unknown>)
          : value;
      const rows = envelope.comments;
      if (!Array.isArray(rows) || rows.length > 50) throw new Error("LINEAR_INVALID_RESPONSE");
      const candidates: readonly unknown[] = rows;
      const found = candidates.find(
        (item) => item !== null && typeof item === "object" && "id" in item && item.id === id,
      );
      if (found !== undefined) {
        if (
          found === null ||
          typeof found !== "object" ||
          !("body" in found) ||
          typeof found.body !== "string"
        )
          throw new Error("LINEAR_INVALID_RESPONSE");
        return stableLinearAssetLinks(found.body);
      }
      const next = value.cursor ?? envelope.cursor ?? envelope.endCursor;
      if (typeof next !== "string" || !next) {
        if (
          envelope.hasNextPage === true ||
          (typeof value.count === "string" && /more available/iu.test(value.count))
        )
          throw new Error("LINEAR_LOOKUP_INCOMPLETE");
        throw new Error("LINEAR_NOT_FOUND");
      }
      if (seen.has(next)) throw new Error("LINEAR_INVALID_RESPONSE");
      cursor = next;
      seen.add(cursor);
    }
    throw new Error("LINEAR_LOOKUP_INCOMPLETE");
  }
  async function stage<T>(content: string, execute: (file: string) => Promise<T>): Promise<T> {
    // A hidden provider-owned file avoids argv size limits. It never holds credentials.
    const directory = await mkdtemp(path.join(tmpdir(), "pi-linear-text-"));
    try {
      const file = path.join(directory, "content.md");
      await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
      return await execute(file);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async function save(
    address: LinearBodyAddress,
    expected: string,
    content: string,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    expected = stableLinearAssetLinks(expected);
    content = stableLinearAssetLinks(content);
    try {
      signal?.throwIfAborted();
      if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024)
        throw new Error("LINEAR_CONTENT_TOO_LARGE");
      if ((await read(address, cwd, signal)).content !== expected)
        throw new Error("LINEAR_STALE_CONTENT");
    } catch (error) {
      throw linearResourceError(
        safeCode(error, "LINEAR_SAVE_REJECTED"),
        address.source,
        "not-applied",
        linearErrorRateLimit(error),
      );
    }
    if (expected === content) return expected;
    const args =
      address.kind === "document-content"
        ? ["documents", "update", "--id", address.identifier, "--content-file"]
        : [
            address.kind === "issue-description" ? "issues" : "projects",
            "update",
            "--id",
            address.identifier,
            "--description-file",
          ];
    const transport = { dispatched: false };
    try {
      await stage(content, async (file) => {
        signal?.throwIfAborted();
        transport.dispatched = true;
        await run(cwd, [...args, file], signal);
      });
    } catch (error) {
      throw linearResourceError(
        safeCode(error, "LINEAR_SAVE_FAILED"),
        address.source,
        transport.dispatched ? "unknown" : "not-applied",
        linearErrorRateLimit(error),
      );
    }
    // Acknowledgement is the write boundary. Readback cannot revoke it.
    try {
      return (await read(address, cwd, signal)).content;
    } catch {
      return undefined;
    }
  }

  const create: LinearTextCreator = async (address, content, cwd, signal) => {
    const parent: LinearBodyAddress = {
      ...address,
      kind:
        address.kind === "create-comment" || address.parentKind === "issue"
          ? "issue-description"
          : "project-description",
    };
    // Resolve and verify the explicit parent before sending any mutation.
    let parentBody: LinearBody;
    try {
      parentBody = await read(parent, cwd, signal);
    } catch (error) {
      throw linearResourceError(
        safeCode(error, "LINEAR_CREATE_REJECTED"),
        address.source,
        "not-applied",
        linearErrorRateLimit(error),
      );
    }
    const args =
      address.kind === "create-document"
        ? [
            "documents",
            "create",
            `--${address.parentKind}`,
            address.identifier,
            "--title",
            address.title,
            "--content-file",
          ]
        : ["comments", "create", "--issue", address.identifier, "--body-file"];
    const transport = { dispatched: false };
    try {
      const output = await stage(content, async (file) => {
        signal?.throwIfAborted();
        transport.dispatched = true;
        return run(cwd, [...args, file], signal);
      });
      const root = address.kind === "create-document" ? "document" : "comment";
      const value = decodeAxiObject(output, root, ["id", "url"])[root];
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("LINEAR_INVALID_RESPONSE");
      const row = value as Record<string, unknown>;
      if (typeof row.id !== "string" || !isDocumentId(row.id))
        throw new Error("LINEAR_INVALID_RESPONSE");
      const source =
        address.kind === "create-document"
          ? `linear://${address.workspace}/document/${row.id.toLowerCase()}/content`
          : `linear://${address.workspace}/issue/${address.identifier}/comment/${row.id.toLowerCase()}`;
      // Keep the acknowledged identity without depending on another remote read.
      return {
        id: row.id,
        source,
        url:
          typeof row.url === "string"
            ? row.url
            : address.kind === "create-document"
              ? `linear://${address.workspace}/document/${row.id.toLowerCase()}`
              : parentBody.url,
      } satisfies CreatedLinearText;
    } catch (error) {
      throw linearResourceError(
        safeCode(error, "LINEAR_CREATE_FAILED"),
        address.source,
        error instanceof ResourceError
          ? error.effect
          : transport.dispatched
            ? "unknown"
            : "not-applied",
        linearErrorRateLimit(error),
      );
    }
  };
  return { read, save, create, readComment };
}

function safeCode(error: unknown, fallback: string): string {
  if (error instanceof ResourceError) return error.code;
  return error instanceof Error && /^LINEAR_[A-Z_]+$/u.test(error.message)
    ? error.message
    : fallback;
}

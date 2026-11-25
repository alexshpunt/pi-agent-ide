import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import type { LinearDocument, LinearIssue } from "./axi.ts";
import { documentLink, parseDocumentUrl, parseIssueUrl, parsePageUrl } from "./urls.ts";
import { parseResourceAddress, parseSearchAddress } from "./object-search.ts";
import { attachmentReadUrl } from "./asset-address.ts";
import { linearErrorRateLimit, linearResourceError } from "./resource-failure.ts";
import { captureLinearJson, type LinearJsonCapture } from "./json-read.ts";

export { parseIssueUrl } from "./urls.ts";

/** Backend boundary shared by live CLI reads and deterministic provider tests. */
export type IssueReader = (
  source: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<LinearIssue>;

/** Fetch full document content only when its own link is read. */
export type DocumentReader = (
  source: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<LinearDocument>;

/** Fetch a team/project card or one bounded list page only when Read requests it. */
export type PageReader = (
  source: string,
  cwd: string,
  signal?: AbortSignal,
  capture?: LinearJsonCapture,
) => Promise<string>;
function safeCode(error: unknown): string {
  if (error instanceof ResourceError) return error.code;
  const code = error instanceof Error ? error.message : "";
  return /^LINEAR_[A-Z_]+$/u.test(code) ? code : "LINEAR_READ_FAILED";
}

function issueText(issue: LinearIssue, workspace: string): string {
  const metadata = [
    ["URL", issue.url],
    ["Editable description", `linear://${workspace}/issue/${issue.id}/description`],
    ["Fields", `linear://${workspace}/issue/${issue.id}#fields`],
    ["Actions", `linear://${workspace}/issue/${issue.id}#actions`],
    ["Comments", `${issue.url}#comments`],
    ["Subtasks", `${issue.url}#subtasks`],
    ["Artifact references", `${issue.url}#attachments`],
    ["Status", issue.status],
    ["Project", issue.project],
    ["Team", issue.team],
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`);
  const links: string[] = [];
  if (issue.attachments) {
    links.push(
      `## Attachments (${issue.attachments.length})`,
      ...issue.attachments.map(
        (item) =>
          `- ${item.title.replace(/[\r\n]+/gu, " ")}: <${attachmentReadUrl(workspace, item.url)}>`,
      ),
      "",
    );
  }
  if (issue.documents) {
    links.push(
      `## Documents (${issue.documents.length})`,
      ...issue.documents.map(
        (item) =>
          `- ${item.title.replace(/[\r\n]+/gu, " ")}: <${documentLink(workspace, item.id)}>`,
      ),
      "",
    );
  }
  return [`# ${issue.id}: ${issue.title}`, "", ...metadata, "", ...links, issue.description].join(
    "\n",
  );
}

/** Own supported read-only Linear URLs; resolution performs no backend reads. */
export function createLinearResolver(
  readIssue: IssueReader,
  readDocument?: DocumentReader,
  readPage?: PageReader,
  readAuxiliary?: PageReader,
): ResourceResolver {
  return {
    id: "linear",
    async tryResolve(source, context) {
      let reference;
      let document;
      let page;
      try {
        const auxiliary = parseSearchAddress(source) ?? parseResourceAddress(source);
        if (auxiliary) {
          return {
            kind: "resolved",
            resource: {
              source: auxiliary.source,
              link: auxiliary.source,
              async read(operation) {
                const signal = operation.signal ?? context.signal;
                try {
                  if (!readAuxiliary) throw new Error("LINEAR_RESOURCE_UNAVAILABLE");
                  return await captureLinearJson((capture) =>
                    readAuxiliary(auxiliary.source, context.cwd, signal, capture),
                  );
                } catch (error) {
                  signal?.throwIfAborted();
                  throw linearResourceError(
                    safeCode(error),
                    source,
                    "not-applied",
                    linearErrorRateLimit(error),
                  );
                }
              },
            },
          };
        }
        page = parsePageUrl(source);
        document = page ? undefined : parseDocumentUrl(source);
        reference = page ?? document ?? parseIssueUrl(source);
      } catch (error) {
        return { kind: "failed", error: new Error(`${safeCode(error)}: https://linear.app`) };
      }
      if (!reference) return { kind: "not-handled" };
      return {
        kind: "resolved",
        resource: {
          source: reference.source,
          link: reference.source,
          async read(operation) {
            const signal = operation.signal ?? context.signal;
            signal?.throwIfAborted();
            try {
              return await captureLinearJson(async (capture) => {
                if (page) {
                  if (!readPage) throw new Error("LINEAR_PAGE_UNAVAILABLE");
                  return readPage(reference.source, context.cwd, signal, capture);
                }
                if (document) {
                  if (!readDocument) throw new Error("LINEAR_DOCUMENT_UNAVAILABLE");
                  const data = await readDocument(reference.source, context.cwd, signal);
                  capture(data);
                  return [
                    `# ${data.title}`,
                    "",
                    `URL: ${data.url}`,
                    `Editable content: linear://${document.workspace}/document/${data.id}/content`,
                    "",
                    data.content,
                  ].join("\n");
                }
                const data = await readIssue(reference.source, context.cwd, signal);
                capture(data);
                return issueText(data, reference.workspace);
              });
            } catch (error) {
              signal?.throwIfAborted();
              throw linearResourceError(
                safeCode(error),
                reference.source,
                "not-applied",
                linearErrorRateLimit(error),
              );
            }
          },
        },
      };
    },
  };
}

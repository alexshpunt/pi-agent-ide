import type { ReadPluginApi } from "pi-agent-ide/api/read";
import type { LinearJsonCapture } from "./json-read.ts";
import type { ResourceTextReader } from "./search.ts";
import { decodeAxiObject, runAxi } from "./axi.ts";
import { attachmentReadUrl } from "./asset-address.ts";
import {
  objectPageText,
  parseResourceAddress,
  parseSearchAddress,
  searchAxiObjects,
} from "./object-search.ts";

/** Search reads canonical script text, never the agent's truncated preview or rendered anchors. */
export function textFromRead(
  getApi: () => Pick<ReadPluginApi, "read"> | undefined,
): ResourceTextReader {
  return async (source, cwd, signal) => {
    const api = getApi();
    if (!api) throw new Error("LINEAR_READ_UNAVAILABLE");
    const result = await api.read({ path: source }, { cwd, signal }, "script");
    if (result.isError || !result.script) throw new Error("LINEAR_RESOURCE_READ_FAILED");
    const data = result.script;
    if (data.kind !== "text" || data.startLine !== 1 || data.endLine !== data.totalLines)
      throw new Error("LINEAR_NON_TEXT_RESOURCE");
    return { source: data.source, content: data.content, complete: true };
  };
}
/** Read one search continuation or explicit directory card; linked bodies remain lazy. */
export function createAuxiliaryReader(readText: ResourceTextReader, run: typeof runAxi = runAxi) {
  return async (
    source: string,
    cwd: string,
    signal?: AbortSignal,
    capture?: LinearJsonCapture,
  ): Promise<string> => {
    const search = parseSearchAddress(source);
    if (search) {
      const page = await searchAxiObjects({ ...search, scope: source }, cwd, signal);
      capture?.(
        page,
        [
          page.complete ? "End of API results." : "Coverage: this page only.",
          ...(page.notice ? [page.notice] : []),
          ...(page.next ? [`Next page: ${page.next}`] : []),
        ].join("\n"),
      );
      return objectPageText(page);
    }
    const address = parseResourceAddress(source);
    if (!address) throw new Error("LINEAR_INVALID_URL");
    const resource = decodeAxiObject(
      await run(
        cwd,
        [
          "resources",
          "view",
          address.kind,
          address.id,
          "--workspace",
          address.workspace,
          ...(address.parent ? ["--scope", address.parent] : []),
          ...(address.query ? ["--query", address.query] : []),
          ...(address.cursor ? ["--cursor", address.cursor] : []),
        ],
        signal,
      ),
      "resource",
      ["workspace", "kind", "data"],
    ).resource;
    if (!resource || typeof resource !== "object" || Array.isArray(resource))
      throw new Error("LINEAR_INVALID_RESPONSE");
    const row = resource as Record<string, unknown>;
    if (
      row.workspace !== address.workspace ||
      row.kind !== address.kind ||
      typeof row.data !== "string"
    )
      throw new Error("LINEAR_IDENTITY_MISMATCH");
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch (error) {
      throw new Error("LINEAR_INVALID_RESPONSE", { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("LINEAR_INVALID_RESPONSE");
    const value = parsed as Record<string, unknown>;
    if (address.kind === "attachments") {
      const raw = value.downloadUrl ?? value.url;
      if (typeof raw !== "string") throw new Error("LINEAR_ATTACHMENT_UNAVAILABLE");
      const url = new URL(raw);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
        throw new Error("LINEAR_INVALID_RESPONSE");
      // The URL's provider owns access. Never copy AXI credentials to an external host.
      const snapshot = await readText(attachmentReadUrl(address.workspace, url.href), cwd, signal);
      if (!snapshot.complete) throw new Error("LINEAR_ATTACHMENT_INCOMPLETE");
      return snapshot.content;
    }
    if (value.id !== address.id) throw new Error("LINEAR_IDENTITY_MISMATCH");
    capture?.(value);
    return [
      `# ${typeof value.name === "string" ? value.name : typeof value.title === "string" ? value.title : address.kind}`,
      "",
      `URL: ${source}`,
      "",
      ...Object.entries(value).map(([key, value]) =>
        typeof value === "string" ? `${key}: ${value}` : `${key}: ${JSON.stringify(value)}`,
      ),
    ].join("\n");
  };
}

import path from "node:path";
import { URI } from "vscode-uri";

/** Resolve a document in its server owner, never as a local spelling of a remote URI. */
export function documentUri(input: string, rootUri: string): string {
  if (rootUri.startsWith("ssh://")) {
    const root = checkedRemote(rootUri);
    if (input.includes("://")) {
      const document = checkedRemote(input);
      if (document.host !== root.host)
        throw new Error("Document belongs to another language server owner");
      return document.href;
    }
    const absolute = path.posix.resolve(decodeURIComponent(root.pathname), input);
    root.pathname = absolute.split("/").map(encodeURIComponent).join("/");
    return root.href;
  }
  if (input.startsWith("ssh://") || (input.includes("://") && !input.startsWith("file://"))) {
    throw new Error("Document belongs to another language server owner");
  }
  return input.startsWith("file://") ? input : URI.file(input).toString();
}

function checkedRemote(input: string): URL {
  const uri = new URL(input);
  if (
    uri.protocol !== "ssh:" ||
    !uri.hostname ||
    uri.username ||
    uri.password ||
    uri.port ||
    uri.search ||
    uri.hash
  ) {
    throw new Error("Invalid language server resource owner");
  }
  // Validate escapes even when this is already an absolute URI.
  decodeURIComponent(uri.pathname);
  return uri;
}

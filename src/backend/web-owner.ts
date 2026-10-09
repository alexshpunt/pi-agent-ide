import type { ContentHost, ResourceResolver } from "pi-agent-resource";
import { createWebResolver } from "#src/extensions/pi-agent-read/extensions/pi-agent-web/src/resolver.js";
import { SshBackendError } from "./ssh.js";
import type { SshBackendRegistry } from "./registry.js";
import { fetchSshWebResponse } from "./web-http.js";
import { readSshBrowserPage } from "./web-browser.js";

/** An explicit target web source; the nested HTTP(S) URL retains its query and fragment. */
export function parseSshWebSource(
  source: string,
): { target: string; url: URL; source: string } | undefined {
  if (!/^web:/iu.test(source)) return undefined;
  const match = /^web:ssh:\/\/([a-z0-9._-]+)\/(https?:\/\/.+)$/iu.exec(source);
  if (!match?.[1] || !match[2]) throw new SshBackendError("INVALID_SOURCE", source, "not-applied");
  let url: URL;
  try {
    url = new URL(match[2]);
  } catch {
    throw new SshBackendError("INVALID_SOURCE", source, "not-applied");
  }
  if (url.username || url.password)
    throw new SshBackendError("INVALID_SOURCE", source, "not-applied");
  return { target: match[1], url, source: `web:ssh://${match[1]}/${url.href}` };
}

/** Resolve only explicit target URLs; conversion stays local and target failures never use local egress. */
export function createSshWebResolver(
  host: Pick<ContentHost, "convert">,
  registry: SshBackendRegistry,
): ResourceResolver {
  return {
    id: "ssh-web",
    async tryResolve(source, context) {
      try {
        const selected = parseSshWebSource(source);
        if (!selected) return { kind: "not-handled" };
        context.signal?.throwIfAborted();
        const owner = registry.resolve(`ssh://${selected.target}/`);
        if (!owner) throw new SshBackendError("UNSUPPORTED_SOURCE", selected.source, "not-applied");
        const resolver = createWebResolver(host, {
          fetch: async (_input, init) =>
            fetchSshWebResponse(
              owner.backend.target,
              selected.url,
              selected.source,
              init?.signal ?? undefined,
            ),
          browser: {
            load(url, options) {
              return readSshBrowserPage(owner.backend.target, url, selected.source, options);
            },
          },
        });
        const result = await resolver.tryResolve(selected.url.href, context);
        if (result.kind !== "resolved") return result;
        return { kind: "resolved", resource: { ...result.resource, source: selected.source } };
      } catch (error) {
        return {
          kind: "failed",
          error:
            error instanceof SshBackendError
              ? new SshBackendError(error.code, source, error.effect)
              : error,
        };
      }
    },
  };
}

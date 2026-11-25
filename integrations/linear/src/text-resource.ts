import { ResourceError, type ResourceResolver } from "pi-agent-ide/api/resource";
import { parseTextAddress } from "./text-address.ts";
import type { createLinearTextBackend } from "./text-backend.ts";

/** Resolve payload-only writable text; metadata-bearing cards remain read-only. */
export function createLinearTextResolver(
  backend: ReturnType<typeof createLinearTextBackend>,
): ResourceResolver {
  return {
    id: "linear-text",
    async tryResolve(source, context) {
      const address = parseTextAddress(source);
      if (!address) {
        if (
          !/^linear:\/\/[A-Za-z0-9_-]+\/issue\/[A-Z][A-Z0-9]*-\d+\/comment\/[0-9a-f-]{36}$/u.test(
            source,
          )
        )
          return { kind: "not-handled" };
        const comment = await backend.readComment(source, context.cwd, context.signal);
        return {
          kind: "resolved",
          resource: {
            source,
            link: comment.url,
            read: async () => [{ type: "text", text: comment.content }],
          },
        };
      }
      if (address.kind === "create-document" || address.kind === "create-comment") {
        return {
          kind: "resolved",
          resource: {
            source: address.source,
            read: async () => [{ type: "text", text: "" }],
          },
        };
      }
      const body = await backend.read(address, context.cwd, context.signal);
      let expected: string | undefined = body.content;
      const current = async (
        signal?: AbortSignal,
        effect: "applied" | "not-applied" = "applied",
      ): Promise<string> => {
        if (expected !== undefined) return expected;
        try {
          return (expected = (await backend.read(address, context.cwd, signal)).content);
        } catch {
          throw new ResourceError("LINEAR_READBACK_UNAVAILABLE", address.source, effect);
        }
      };
      return {
        kind: "resolved",
        resource: {
          source: address.source,
          link: body.url,
          get sourceBytes() {
            return expected === undefined ? undefined : Buffer.from(expected, "utf8");
          },
          read: async (operation) => [{ type: "text", text: await current(operation.signal) }],
          async write(blocks, operation) {
            if (blocks.length !== 1 || blocks[0].type !== "text")
              throw new ResourceError("LINEAR_TEXT_REQUIRED", address.source, "not-applied");
            expected = await backend.save(
              address,
              await current(operation.signal, "not-applied"),
              blocks[0].text,
              context.cwd,
              operation.signal,
            );
          },
        },
      };
    },
  };
}

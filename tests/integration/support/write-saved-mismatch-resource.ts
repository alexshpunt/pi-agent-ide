import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TextEditorPluginApi } from "pi-agent-text-editor/api/plugin-protocol";
import type * as ResourceSdk from "pi-agent-resource";
import type * as TextEditorSdk from "pi-agent-ide/api/text-editor";
import type * as CandidateRendererSdk from "#pi-agent-text-editor-renderer/src/renderer.js";

const source = "fixture://saved-mismatch/content";

/** Save once, then report an unknown verification result through the public Resource contract. */
export default async function writeSavedMismatchResource(pi: ExtensionAPI): Promise<void> {
  const canonical = process.env.WRITE_FAILURE_CANONICAL_IDE_SOURCE;
  const { ResourceError } = canonical
    ? ((await import(path.join(canonical, "src/api/resource.ts"))) as typeof ResourceSdk)
    : await import("pi-agent-resource");
  const { connectTextEditorPlugin, TEXT_EDITOR_PROTOCOL, TEXT_EDITOR_API_VERSION } = canonical
    ? ((await import(path.join(canonical, "src/api/text-editor.ts"))) as typeof TextEditorSdk)
    : await import("pi-agent-ide/api/text-editor");
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setToolsExpanded(process.env.WRITE_FAILURE_EXPANDED === "1");
  });
  let installCandidateRenderer: (() => void) | undefined;
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "fixture-saved-mismatch",
    async setup(api: TextEditorPluginApi) {
      const candidate = process.env.WRITE_FAILURE_CANDIDATE_RENDERER;
      if (candidate) {
        const { registerMutationRenderers } = (await import(
          candidate
        )) as typeof CandidateRendererSdk;
        // Register after setup commits, so existing mutation listeners use the active API.
        installCandidateRenderer = () =>
          registerMutationRenderers({
            ...api,
            onMutationTool(listener) {
              return api.onMutationTool((registration) => {
                if (registration.name === "write") listener(registration);
              });
            },
            addToolRenderer(registration) {
              api.addToolRenderer({
                ...registration,
                fallback: false,
                matches(value, phase) {
                  const result = value as {
                    path?: string;
                    details?: { results?: { data: { path?: string } }[] };
                  };
                  return phase === "call"
                    ? result.path === source
                    : result.details?.results?.some((item) => item.data.path === source) === true;
                },
              });
            },
          });
      }
      api.addResolver({
        priority: -100,
        resolver: {
          id: "fixture-saved-mismatch-resource",
          async tryResolve(requested, context) {
            if (requested !== source) return { kind: "not-handled" };
            const file = path.join(context.cwd, "saved.md");
            return {
              kind: "resolved",
              resource: {
                source,
                async read(operation) {
                  return [
                    {
                      type: "text",
                      text: await readFile(file, {
                        encoding: "utf8",
                        signal: operation.signal,
                      }),
                    },
                  ];
                },
                async write(content, operation) {
                  operation.signal?.throwIfAborted();
                  const block = content[0];
                  if (content.length !== 1 || block.type !== "text")
                    throw new Error("Fixture requires one text block");
                  await appendFile(
                    path.join(context.cwd, "attempts.jsonl"),
                    JSON.stringify({ content: block.text }) + "\n",
                  );
                  await writeFile(file, block.text, { signal: operation.signal });
                  throw new ResourceError("PROVIDER_SAVE_VERIFICATION_FAILED", source, "unknown");
                },
              },
            };
          },
        },
      });
    },
  });
  installCandidateRenderer?.();
}

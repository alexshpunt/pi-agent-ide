import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { connectTextEditorPlugin } from "pi-agent-text-editor/api/connect-plugin";
import {
  TEXT_EDITOR_API_VERSION,
  TEXT_EDITOR_PROTOCOL,
} from "pi-agent-text-editor/api/plugin-protocol";

/** Observe real files and public hooks without changing the editor's execution path. */
export default async function nativeBatchProbe(pi: ExtensionAPI): Promise<void> {
  const slowParents = new Set<string>();
  const record = (cwd: string, event: unknown) =>
    appendFile(path.join(cwd, "batch-events.jsonl"), JSON.stringify(event) + "\n");
  pi.on("tool_call", async (event, context) => {
    if (!event.parentToolCallId && event.toolName !== "write") return;
    const input: Record<string, unknown> = event.input;
    const source =
      typeof input.path === "string" ? path.resolve(context.cwd, input.path) : undefined;
    const content = source ? await readFile(source, "utf8").catch(() => null) : null;
    await record(context.cwd, {
      type: "call",
      id: event.toolCallId,
      parent: event.parentToolCallId,
      name: event.toolName,
      content,
      ...(event.toolName === "write" && source
        ? {
            mtimeMs: await stat(source)
              .then((file) => file.mtimeMs)
              .catch(() => null),
          }
        : {}),
    });
    if (input.text === "BLOCKED") return { block: true, reason: "fixture blocked this edit" };
    return;
  });
  pi.on("tool_result", async (event, context) => {
    // Keep the real workspace alive long enough to catch effects after the parent finishes.
    if (slowParents.delete(event.toolCallId))
      await new Promise((resolve) => setTimeout(resolve, 3500));
    if (!event.parentToolCallId && event.toolName !== "write") return;
    await record(context.cwd, {
      type: "result",
      id: event.toolCallId,
      parent: event.parentToolCallId,
      name: event.toolName,
      isError: event.isError,
      ...(event.toolName === "write" && typeof event.input.path === "string"
        ? {
            content: await readFile(path.resolve(context.cwd, event.input.path), "utf8").catch(
              () => null,
            ),
            mtimeMs: await stat(path.resolve(context.cwd, event.input.path))
              .then((file) => file.mtimeMs)
              .catch(() => null),
          }
        : {}),
    });
    if (event.input.text === "ABORT_PENDING" && !event.isError) context.abort();
    if (event.input.text === "SLOW_BOUNDARY" && event.parentToolCallId)
      slowParents.add(event.parentToolCallId);
    // A different writer changes the real file after acceptance but before commit.
    if (event.input.text === "RACE" && typeof event.input.path === "string")
      await writeFile(path.resolve(context.cwd, event.input.path), "external\n");
    if (event.input.path === "created.txt" && event.toolName === "write")
      await writeFile(path.resolve(context.cwd, event.input.path), "");
  });
  await connectTextEditorPlugin(pi, {
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    id: "native-batch-probe",
    setup(api) {
      api.addMutationGuard({
        id: "native-batch-guard",
        async guard(plan, context) {
          await record(context.cwd, {
            type: "guard",
            files: plan.resources.map((resource) => resource.source),
          });
          if (plan.resources.some((resource) => resource.after.content.includes("SLOW_BOUNDARY")))
            await new Promise((resolve) => setTimeout(resolve, 3000));
          return plan.resources.some((resource) => resource.after.content.includes("GUARDED"))
            ? {
                kind: "rejected",
                rejection: {
                  code: "FIXTURE_GUARD",
                  reason: "fixture",
                  message: "fixture rejected the combined write",
                  effect: "not-applied",
                },
              }
            : { kind: "accepted" };
        },
      });
      api.onDidEdit(async (completion) => {
        await record(completion.cwd, {
          // An interrupted final notification can describe already-saved bytes without a new edit.
          type:
            completion.postProcessing === "final" ||
            (completion.postProcessing === "interrupted" &&
              completion.before.content === completion.after.content)
              ? "post-edit"
              : "edit",
          path: completion.resourceSource,
          before: completion.before.content,
          after: completion.after.content,
        });
      });
    },
  });
}

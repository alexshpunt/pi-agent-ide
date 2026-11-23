import { appendFile, lstat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  connectAfterDeleteHook,
  connectAfterEditHook,
  connectBeforeDeleteHook,
  connectBeforeEditHook,
} from "#src/api/hooks.ts";

export const editDenial = `Use the fixture's alternate route.\n${"Long remediation line. ".repeat(12)}\nStill blocked?!`;

type HookEvent = {
  readonly type: string;
  readonly toolCallId?: string;
  readonly path?: unknown;
  readonly kind?: string;
  readonly missing?: boolean;
  readonly content?: string;
  readonly resources?: readonly {
    readonly path: string;
    readonly existed: boolean;
    readonly deleted: boolean;
    readonly before: string | number[];
    readonly after: string | number[];
  }[];
};

export default function (pi: ExtensionAPI) {
  const record = (cwd: string, event: HookEvent) =>
    appendFile(path.join(cwd, "hook-events.jsonl"), `${JSON.stringify(event)}\n`);
  pi.on("tool_call", async (event, context) => {
    if (event.toolName !== "write" && event.toolName !== "delete") return;
    await record(context.cwd, {
      type: "call",
      toolCallId: event.toolCallId,
      path: event.input.path,
    });
  });
  void connectBeforeEditHook(pi, {
    id: "record-edit-plan",
    async run({ cwd, toolCallId, resources }) {
      await record(cwd, {
        type: "before-edit",
        toolCallId,
        resources: resources.map(({ resourceSource, existed, deleted, before, after, binary }) => ({
          path: path.relative(cwd, resourceSource),
          existed,
          deleted,
          before: binary ? [...binary.before] : before.content,
          after: binary ? [...binary.after] : after.content,
        })),
      });
      return resources.some(
        ({ resourceSource }) =>
          resourceSource.endsWith("protected.txt") &&
          !resourceSource.includes(`${path.sep}source${path.sep}`),
      )
        ? { decision: "deny", reason: editDenial }
        : { decision: "allow" };
    },
  });
  void connectAfterEditHook(pi, {
    id: "record-saved-edit",
    async run({ cwd, toolCallId, resourceSource, after }) {
      await record(cwd, {
        type: "after-edit",
        toolCallId,
        path: path.relative(cwd, resourceSource),
        content: after.content,
      });
    },
  });
  void connectBeforeDeleteHook(pi, {
    id: "record-delete-policy",
    async run({ cwd, toolCallId, resolvedPath, kind }) {
      await record(cwd, {
        type: "before-delete",
        toolCallId,
        path: path.relative(cwd, resolvedPath),
        kind,
      });
      return resolvedPath.endsWith("keep-delete")
        ? { decision: "deny", reason: "Keep this fixture" }
        : { decision: "allow" };
    },
  });
  void connectAfterDeleteHook(pi, {
    id: "record-deleted-object",
    async run({ cwd, toolCallId, resolvedPath, kind }) {
      const missing = await lstat(resolvedPath).then(
        () => false,
        (error: NodeJS.ErrnoException) => error.code === "ENOENT",
      );
      await record(cwd, {
        type: "after-delete",
        toolCallId,
        path: path.relative(cwd, resolvedPath),
        kind,
        missing,
      });
      throw new Error("Observer failure must not change the operation result");
    },
  });
}

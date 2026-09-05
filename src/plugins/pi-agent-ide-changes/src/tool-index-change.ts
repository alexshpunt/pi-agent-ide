import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  defineTool,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ChangeService } from "#src/changes/change-service.js";

import type { ChangeIndexAction } from "#src/changes/change-types.js";
import type { GitCommandExecutor } from "#src/changes/git-changes-backend.js";
import type { IndexMutationQueue } from "#src/index-mutation-queue.js";

const indexChangeSchema = Type.Object(
  {
    file: Type.String({ description: "Path to the tracked text file" }),
    change: Type.String({
      description: "Complete CHANGE#HASH anchor shown by read",
      pattern: "^CHANGE#[0-9A-F]{4,64}$",
    }),
  },
  { additionalProperties: false },
);

interface IndexChangeToolDetails {
  readonly action: ChangeIndexAction;
  readonly change: string;
  readonly file: string;
  readonly state: "staged" | "unstaged";
  readonly unchanged: boolean;
}

export function registerIndexChangeTools(
  pi: ExtensionAPI,
  executor: GitCommandExecutor,
  queue: IndexMutationQueue,
): void {
  pi.registerTool(createIndexChangeTool("stage", executor, queue));
  pi.registerTool(createIndexChangeTool("unstage", executor, queue));
}

function createIndexChangeTool(
  action: ChangeIndexAction,
  executor: GitCommandExecutor,
  queue: IndexMutationQueue,
) {
  const targetState = action === "stage" ? "staged" : "unstaged";
  const pastTense = action === "stage" ? "Staged" : "Unstaged";

  return defineTool<typeof indexChangeSchema, IndexChangeToolDetails>({
    name: action,
    label: action,

    promptSnippet: `${pastTense.slice(0, -1)} a selected Git change`,
    description: `${pastTense.slice(
      0,
      -1,
    )} one current Git change selected by a CHANGE# anchor without changing the worktree.`,
    promptGuidelines: [
      `You can use ${action} with a complete \`CHANGE#...\` anchor to ${action} only that current Git change without changing the worktree.`,
    ],
    parameters: indexChangeSchema,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      const file = resolveFile(parameters.file, context.cwd);

      return withFileMutationQueue(file, () =>
        queue.run(async () => {
          const worktreeText = await readFile(file, "utf8");
          const creation = await ChangeService.create(executor, context.cwd, signal);

          if (creation.status !== "ready") {
            throw new Error(creation.message);
          }

          const result = await creation.service.changeIndex(
            {
              source: file,
              worktreeText,
              cwd: context.cwd,
              ...(signal !== undefined && { signal }),
            },
            parameters.change,
            action,
          );

          if (result.status === "unavailable") {
            throw new Error(result.message);
          }

          if (result.status === "not-applicable") {
            throw new Error(`${action} is not applicable to ${file}: ${result.reason}`);
          }

          const isUnchanged = result.status === "unchanged";
          const text = isUnchanged
            ? `${parameters.change} is already ${targetState} in ${parameters.file}.`
            : `${pastTense} ${parameters.change} in ${parameters.file}.`;

          return {
            content: [{ type: "text", text }],
            details: {
              action,
              change: parameters.change,
              file,
              state: targetState,
              unchanged: isUnchanged,
            },
          };
        }),
      );
    },
  });
}

function resolveFile(file: string, cwd: string): string {
  const normalized = file.startsWith("@") ? file.slice(1) : file;
  return path.resolve(cwd, normalized);
}

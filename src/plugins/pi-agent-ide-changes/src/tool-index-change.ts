import { readFile } from "node:fs/promises";

import {
  defineTool,
  type AgentToolResult,
  type ExtensionContext,
  type ExtensionAPI,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { resultError, structuredResultSchema, withStructuredResult } from "pi-agent-resource";
const indexDataSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("stage"), Type.Literal("unstage")]),
    change: Type.String(),
    file: Type.String(),
    state: Type.Optional(Type.Union([Type.Literal("staged"), Type.Literal("unstaged")])),
    effect: Type.Union([
      Type.Literal("applied"),
      Type.Literal("not-applied"),
      Type.Literal("unknown"),
    ]),
    unchanged: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const indexOutputSchema = structuredResultSchema(indexDataSchema);

import { ChangeService } from "#src/changes/change-service.js";
import { gitSourceDirectory, resolveGitSource } from "#src/changes/git-paths.js";

import type { ChangeIndexAction } from "#src/changes/change-types.js";
import type { GitCommandExecutor } from "#src/changes/git-changes-backend.js";
import type { IndexMutationQueue } from "#src/index-mutation-queue.js";

/** Shared validation for standalone and composed index changes. */
export const indexChangeSchema = Type.Object(
  {
    file: Type.String({ description: "Path to the tracked text file" }),
    change: Type.String({
      description: "Complete CHANGE#HASH anchor shown by read",
      pattern: "^CHANGE#[0-9A-F]{4,64}$",
    }),
  },
  { additionalProperties: false },
);

const unstageChangeSchema = Type.Object(
  {
    file: {
      ...indexChangeSchema.properties.file,
      description:
        "Path to a tracked text file in the current Git worktree. Relative paths resolve from the workspace.",
    },
    change: {
      ...indexChangeSchema.properties.change,
      description:
        'Select one complete current CHANGE#HASH anchor returned by read with views: ["changes"].',
    },
  },
  { additionalProperties: false },
);

interface IndexChangeToolDetails {
  readonly action: ChangeIndexAction;
  readonly change: string;
  readonly file: string;
  readonly state?: "staged" | "unstaged";
  readonly unchanged?: boolean;
}

export function registerIndexChangeTools(
  pi: ExtensionAPI,
  executor: GitCommandExecutor,
  queue: IndexMutationQueue,
): void {
  pi.registerTool(createIndexChangeTool("stage", executor, queue));
  pi.registerTool(createIndexChangeTool("unstage", executor, queue));
}

/** Build one guarded index change tool. */
export function createIndexChangeTool(
  action: ChangeIndexAction,
  executor: GitCommandExecutor,
  queue: IndexMutationQueue,
) {
  const execute = createIndexChangeExecutor(action, executor, queue);
  const pastTense = action === "stage" ? "Staged" : "Unstaged";
  const parameters =
    action === "stage"
      ? {
          ...indexChangeSchema,
          properties: {
            file: {
              ...indexChangeSchema.properties.file,
              description:
                "Path to the tracked text file, absolute or relative to the current working directory.",
            },
            change: {
              ...indexChangeSchema.properties.change,
              description:
                'Use the complete current CHANGE#HASH anchor shown by read with views: ["changes"].',
            },
          },
        }
      : unstageChangeSchema;

  return defineTool<typeof indexChangeSchema, IndexChangeToolDetails>({
    name: action,
    exposure: "deferred",
    namespace: {
      name: "ide_git",
      description: "Stage or unstage selected Git changes without changing worktree files.",
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    label: action,

    promptSnippet: `${pastTense.slice(0, -1)} a selected Git change`,
    description:
      action === "stage"
        ? "Use stage to add one selected Git change to the index without changing the worktree file."
        : "Use unstage to remove one selected Git change from the index. Worktree content is kept.",
    parameters,
    outputSchema: indexOutputSchema,
    async execute(_toolCallId, parameters, signal, _onUpdate, context) {
      try {
        const result = await execute(parameters, signal, context);
        return withStructuredResult(result, indexDataSchema, {
          status: "success",
          data: { ...result.details, effect: result.details.unchanged ? "not-applied" : "applied" },
          errors: [],
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const failure = resultError(error, "INDEX_CHANGE_FAILED", parameters.file);
        return withStructuredResult(
          {
            content: [{ type: "text", text: failure.message }],
            details: {
              action,
              change: parameters.change,
              file: resolveFile(parameters.file, context.cwd),
            },
          },
          indexDataSchema,
          {
            status: "error",
            data: {
              action,
              change: parameters.change,
              file: resolveFile(parameters.file, context.cwd),
              effect: publicationEffect(error),
            },
            errors: [failure],
          },
        );
      }
    },
  });
}

/** Execute a guarded index change without a synthetic tool context. */
export function createIndexChangeExecutor(
  action: ChangeIndexAction,
  executor: GitCommandExecutor,
  queue: IndexMutationQueue,
) {
  const targetState = action === "stage" ? "staged" : "unstaged";
  const pastTense = action === "stage" ? "Staged" : "Unstaged";
  return async (
    parameters: Static<typeof indexChangeSchema>,
    signal: AbortSignal | undefined,
    context: Pick<ExtensionContext, "cwd">,
  ): Promise<AgentToolResult<IndexChangeToolDetails>> => {
    const file = resolveFile(parameters.file, context.cwd);

    return withFileMutationQueue(file, () =>
      queue.run(async () => {
        const worktreeText = executor.readText
          ? await executor.readText(file, signal)
          : await readFile(file, "utf8");
        const creation = await ChangeService.create(
          executor,
          gitSourceDirectory(file, context.cwd),
          signal,
        );

        if (creation.status !== "ready") {
          throw new Error(
            action === "stage"
              ? `Cannot stage ${parameters.file}: ${creation.message}`
              : creation.message,
          );
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
          if ("failure" in result && result.failure !== undefined) throw result.failure;
          if (action === "stage" && result.reason === "stale-selector") {
            throw Object.assign(
              new Error(
                `${result.message}. Read ${parameters.file} with views: ["changes"] and use a current CHANGE# anchor.`,
              ),
              { effect: "not-applied" },
            );
          }
          if (action === "stage" && result.reason === "index-write-failed" && !signal?.aborted) {
            throw new Error(
              `${result.message}\nThe index may have changed. Read ${parameters.file} with views: ["changes"] before retrying.`,
            );
          }
          throw Object.assign(
            new Error(
              action === "stage" && result.reason !== "index-write-failed"
                ? `Cannot stage ${parameters.file}: ${result.message}`
                : result.message,
            ),
            { effect: "not-applied" },
          );
        }

        if (result.status === "not-applicable") {
          if (action === "stage") {
            const reason =
              result.reason === "clean"
                ? "the worktree text matches HEAD"
                : "the file is not present in HEAD";
            throw new Error(`Cannot stage ${parameters.file}: ${reason}.`);
          }
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
  };
}
function resolveFile(file: string, cwd: string): string {
  const normalized = file.startsWith("@") ? file.slice(1) : file;
  return resolveGitSource(normalized, cwd);
}

function publicationEffect(error: unknown): "applied" | "not-applied" | "unknown" {
  if (
    error !== null &&
    typeof error === "object" &&
    "effect" in error &&
    (error.effect === "applied" || error.effect === "not-applied")
  )
    return error.effect;
  return "unknown";
}

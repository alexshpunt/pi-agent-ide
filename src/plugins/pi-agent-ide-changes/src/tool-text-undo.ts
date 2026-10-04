import { diffChars } from "diff";
import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

import { CHANGE_ANCHOR_KIND } from "#src/change-anchor.js";
import { ChangeService } from "#src/changes/change-service.js";

import type { GitCommandExecutor } from "#src/changes/git-changes-backend.js";
import type { IndexMutationQueue } from "#src/index-mutation-queue.js";
import type { LastTextTransactionStore } from "#src/last-text-transaction-store.js";
import type { TextMutationToolRegistration } from "pi-agent-text-editor/api/mutation-tool";

export const undoSchema = Type.Object(
  {
    file: Type.Optional({
      ...resultInputSchema,
      description:
        "File to restore or one whole-file source result; partial and multi-file scopes are rejected. May be omitted to inherit the previous source.",
    }),
    change: Type.Optional(
      Type.String({
        description:
          "Complete CHANGE#HASH anchor shown by read, or last for this file's latest text-editor transaction",
        pattern: "^(?:CHANGE#[0-9A-F]{4,64}|last)$",
      }),
    ),
  },
  { additionalProperties: false },
);

interface UndoParameters {
  readonly file?: unknown;
  readonly change?: string;
}

export function createUndoMutationTool(
  executor: GitCommandExecutor,
  transactions: LastTextTransactionStore,
  queue: IndexMutationQueue,
): TextMutationToolRegistration<typeof undoSchema> {
  return {
    name: "undo",
    description:
      "Use undo to revert a selected uncommitted Git change or the latest text-editor transaction for one file. CHANGE# restores that change to HEAD in both worktree and index; last restores one file's latest text edit.",

    promptSnippet: "Restore a Git change or latest text edit",
    parameters: undoSchema,
    intent: "restore",
    source: { field: "file", inherited: true },
    anchors: [
      {
        field: "change",
        sourceField: "file",
        kinds: [CHANGE_ANCHOR_KIND],
        nonAnchorValues: ["last"],
      },
    ],
    async mutate(context, parameters: UndoParameters) {
      if (parameters.change === undefined) throw new Error("change is required");
      const source = context.sourceFor("file");
      let restoredText: string;
      let afterWrite: (() => Promise<void>) | undefined;

      if (parameters.change === "last") {
        restoredText = transactions.restore(source, context.cwd, context.sourceDocument.content);
      } else {
        await context.resolveAnchor("change");
        const creation = await ChangeService.create(executor, context.cwd, context.signal);

        if (creation.status !== "ready") {
          throw new Error(creation.message);
        }

        const result = await creation.service.prepareUndo(
          {
            source,
            worktreeText: context.sourceDocument.content,
            cwd: context.cwd,
            ...(context.signal !== undefined && { signal: context.signal }),
          },
          parameters.change,
        );

        if (result.status !== "applied") {
          if (result.status === "unavailable") {
            throw new Error(result.message);
          }

          throw new Error(`Undo is not applicable to ${source}: ${result.reason}`);
        }

        restoredText = result.worktreeText;

        if (result.indexUpdate !== undefined) {
          const update = result.indexUpdate;
          afterWrite = () =>
            queue.run(() => creation.service.applyIndexUpdate(update, context.signal));
        }
      }

      return {
        edits: new Map([
          [
            source,
            {
              changes: createTextChanges(context.sourceDocument.content, restoredText),
              action: "edited",
            },
          ],
        ]),
        ...(afterWrite !== undefined && { afterWrite }),
      };
    },
  };
}

function createTextChanges(currentText: string, restoredText: string) {
  const changes: { from: number; to: number; insert: string }[] = [];
  let sourceOffset = 0;
  let changeStart: number | undefined;
  let removedLength = 0;
  let insertedText = "";

  const flush = (): void => {
    if (changeStart === undefined) {
      return;
    }

    changes.push({
      from: changeStart,
      to: changeStart + removedLength,
      insert: insertedText,
    });
    changeStart = undefined;
    removedLength = 0;
    insertedText = "";
  };

  for (const part of diffChars(currentText, restoredText)) {
    if (!part.added && !part.removed) {
      flush();
      sourceOffset += part.value.length;
      continue;
    }

    changeStart ??= sourceOffset;

    if (part.removed) {
      sourceOffset += part.value.length;
      removedLength += part.value.length;
    } else {
      insertedText += part.value;
    }
  }

  flush();
  return changes;
}

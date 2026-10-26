import { diffChars } from "diff";
import { Type } from "typebox";
import { resultInputSchema } from "pi-agent-resource";

import { CHANGE_ANCHOR_KIND } from "#src/change-anchor.js";
import { ChangeService } from "#src/changes/change-service.js";
import { gitSourceDirectory } from "#src/changes/git-paths.js";

import type { GitCommandExecutor } from "#src/changes/git-changes-backend.js";
import type { IndexMutationQueue } from "#src/index-mutation-queue.js";
import type { LastTextTransactionStore } from "#src/last-text-transaction-store.js";
import type { TextMutationToolRegistration } from "pi-agent-text-editor/api/mutation-tool";

export const undoSchema = Type.Object(
  {
    file: Type.Optional(
      Type.Union(resultInputSchema.anyOf, {
        description:
          "File path or an unchanged whole-file result. Omit to use the file of the CHANGE# anchor or the last file read.",
      }),
    ),
    change: Type.String({
      description:
        'A CHANGE#HASH anchor from read with views: ["changes"] reverts that change to HEAD in the worktree and index; last reverts the file\'s last tool edit.',
      pattern: "^(?:CHANGE#[0-9A-F]{4,64}|last)$",
    }),
  },
  { additionalProperties: false },
);

interface UndoParameters {
  readonly file?: unknown;
  readonly change: string;
}

export function createUndoMutationTool(
  executor: GitCommandExecutor,
  transactions: LastTextTransactionStore,
  queue: IndexMutationQueue,
): TextMutationToolRegistration<typeof undoSchema> {
  return {
    name: "undo",
    description:
      "Use undo to revert one uncommitted Git change or the last edit a tool made to a file.",

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
      const source = context.sourceFor("file");
      let restoredText: string;
      let afterWrite: (() => Promise<void>) | undefined;

      if (parameters.change === "last") {
        restoredText = transactions.restore(source, context.cwd, context.sourceDocument.content);
      } else {
        await context.resolveAnchor("change");
        const creation = await ChangeService.create(
          executor,
          gitSourceDirectory(source, context.cwd),
          context.signal,
        );

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

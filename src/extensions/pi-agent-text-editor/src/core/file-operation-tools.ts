import type { TextEditorCore } from "#src/core/text-editor-core.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  deleteFileParameters,
  transferFileParameters,
  executeFileOperation,
} from "#src/core/file-operations.js";

/** Register whole-file tools using the same execution service as Apply. */
export function registerFileOperationTools(pi: ExtensionAPI, core: TextEditorCore): void {
  for (const [name, description] of [
    [
      "delete_file",
      "Use delete_file to permanently delete one regular file. Reject directories and symlinks. This deletes the file, unlike delete which removes selected text.",
    ],
    [
      "move_file",
      "Use move_file to move or rename one regular file. Reject directories and symlinks. Existing targets require overwrite: true. Works across devices. Configured post-processing can format UTF-8 text targets; binary contents remain unchanged.",
    ],
    [
      "copy_file",
      "Use copy_file to copy one regular file. Reject directories and symlinks. Existing targets require overwrite: true. Configured post-processing can format UTF-8 text targets; binary contents remain unchanged.",
    ],
  ] as const) {
    pi.registerTool({
      name,
      label: name.replaceAll("_", " "),
      renderCall(_args, theme) {
        return new Text(theme.fg("toolTitle", theme.bold(name.replaceAll("_", " "))), 0, 0);
      },
      description,
      promptSnippet: description,
      parameters: name === "delete_file" ? deleteFileParameters : transferFileParameters,
      async execute(_id, args, signal, _update, context) {
        const outcome = await core.enqueueFileOperation(
          () => executeFileOperation(name, args, context.cwd, signal),
          signal,
        );
        let postProcessingError: string | undefined;
        if (outcome.ok && outcome.target !== undefined) {
          try {
            await core.postProcessFile(outcome.target, { cwd: context.cwd, signal });
          } catch (error) {
            postProcessingError = error instanceof Error ? error.message : String(error);
          }
        }
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${name.replaceAll("_", " ")}: ${outcome.effect}`,
                outcome.path,
                postProcessingError === undefined
                  ? undefined
                  : `Post-processing failed: ${postProcessingError}`,
                outcome.target === undefined ? undefined : `Target: ${outcome.target}`,
                outcome.error === undefined
                  ? undefined
                  : `${outcome.error.code}: ${outcome.error.message}`,
              ]
                .filter((line) => line !== undefined)
                .join("\n"),
            },
          ],
          details: {
            ...outcome,
            ...(postProcessingError === undefined ? {} : { postProcessingError }),
          },
          isError: !outcome.ok,
        };
      },
    });
  }
}

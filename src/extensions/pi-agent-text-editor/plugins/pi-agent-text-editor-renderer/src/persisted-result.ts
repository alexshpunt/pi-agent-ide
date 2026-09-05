import {
  FileMutationResult,
  type FileMutationBatchResult,
} from "pi-agent-text-editor/api/mutation-result";
import { resolveMutationResultResources } from "./mutation-result.js";
import type { DiffModel } from "./diff-model.js";

/** Width- and theme-independent fragments retained in session history. */
export interface PersistedMutationResource {
  readonly path: string;
  readonly model: DiffModel;
}

/** Completed history owns diff fragments, not the engine's document snapshots. */
export interface PersistedMutationDetails extends FileMutationBatchResult {
  readonly mutationRender?: readonly PersistedMutationResource[];
}

/** Projects a finished result after its model-facing answer has been prepared. */
export function compactMutationDetails(details: FileMutationBatchResult): PersistedMutationDetails {
  const resources = resolveMutationResultResources(details, undefined);
  const { displayResults: _display, ...rest } = details as FileMutationBatchResult & {
    displayResults?: unknown;
  };
  return {
    ...rest,
    results: details.results?.map((value) => {
      const result = FileMutationResult.ensure(value);
      const {
        beforeContentMap: _before,
        afterContent: _after,
        afterDocument: _document,
        snapshot: _snapshot,
        activeEdits: _active,
        inputEdits: _input,
        beforeReadText: _read,
        rawChanges: _changes,
        diffs: _diffs,
        ...data
      } = result.data;
      return new FileMutationResult(data);
    }),
    mutationRender: resources.flatMap(({ path, model }) =>
      model === undefined ? [] : [{ path, model }],
    ),
  };
}

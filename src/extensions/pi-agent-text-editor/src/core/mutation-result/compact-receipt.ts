import { FileMutationResult, type FileMutationBatchResult } from "./file-mutation-result.ts";

const RECEIPT_BYTES = 16 * 1024;

export interface CompactMutationReceipt extends FileMutationBatchResult {
  readonly mutationDetailsTruncated?: true;
}

/** Keep bounded machine receipts, without engine snapshots or display data. */
export function compactMutationReceipt(details: FileMutationBatchResult): CompactMutationReceipt {
  const source = details as CompactMutationReceipt & {
    agenticIdeBatch?: unknown;
    batchRecovery?: unknown;
  };
  const receipt = {
    effect: details.effect,
    metadata: details.metadata,
    phases: details.phases,
    anchorRecoveries: details.anchorRecoveries,
    agenticIdeBatch: source.agenticIdeBatch,
    batchRecovery: source.batchRecovery,
    mutationDetailsTruncated: source.mutationDetailsTruncated,
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
        scopeMarkers: _scopeMarkers,
        diffPeerRanges: _peerRanges,
        diffs: _diffs,
        ...data
      } = result.data;
      return new FileMutationResult(data);
    }),
  };
  return Buffer.byteLength(JSON.stringify(receipt)) <= RECEIPT_BYTES
    ? receipt
    : { effect: details.effect, results: undefined, mutationDetailsTruncated: true };
}

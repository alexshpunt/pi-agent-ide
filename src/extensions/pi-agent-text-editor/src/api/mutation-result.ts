export {
  type AppliedTextChange,
  type DiagnosticHint,
  type EditDiagnosticLine,
  type EditFailureOptions,
  type FileChange,
  type FileError,
  type FileMutationBatchResult,
  type FileMutationData,
  FileMutationResult,
  FileRange,
  type GatePhase,
  type LintViolation,
  type MutationAnchor,
  type MutationSnapshot,
  type StaleAnchorDiagnostic,
  type StaleEditInfo,
  type StrictEditErrorCode,
  type SyntaxErrorSummary,
  type Warning,
} from "#src/core/mutation-result/file-mutation-result.js";

export { type ChangedRange, computeChangedRanges } from "#src/core/mutation-result/diff.js";

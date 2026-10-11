import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { FileMutationBatchResult } from "./mutation-result.js";

/** A finished native editor batch, sent through Pi's event bus without saving raw snapshots. */
export interface NativeEditBatchEvent {
  readonly parentToolCallId: string;
  readonly calls: readonly string[];
  /** Successful Copy calls that retained identical destination text without a write. */
  readonly unchangedCopyCalls?: readonly string[];
  /** Per-call receipts keep only their own output selection and failure evidence. */
  readonly mutationResults?: ReadonlyMap<string, AgentToolResult<FileMutationBatchResult>>;
  readonly result: AgentToolResult<FileMutationBatchResult>;
}

/** Presentation listeners must compact the result before retaining it in history. */
export const NATIVE_EDIT_BATCH_EVENT = "pi-agent-text-editor:native-batch-finished";

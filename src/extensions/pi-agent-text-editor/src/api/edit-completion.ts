import type { TextDocument } from "pi-agent-text";

export type TextEditIntent = "edit" | "restore" | "mixed";

export interface TextEditCompletion {
  /** Deferred writes remain observable; final updates reconcile formatting without another edit. */
  readonly postProcessing?: "deferred" | "final" | "complete";
  readonly source: string;
  readonly resourceSource: string;
  readonly resolvedBy: string;
  readonly cwd: string;
  readonly existed: boolean;
  readonly before: TextDocument;
  readonly after: TextDocument;
  readonly intent: TextEditIntent;
}

export interface TextEditCompletionFeedback {
  readonly feedback: string;
  readonly tone?: "info" | "warning" | "error";
}
export type TextEditCompletionListener = (
  completion: TextEditCompletion,
) => void | TextEditCompletionFeedback | Promise<void | TextEditCompletionFeedback>;

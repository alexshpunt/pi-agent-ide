import type { TextDocument } from "pi-agent-text";

export type TextEditIntent = "edit" | "restore" | "mixed";

export interface TextEditCompletion {
  readonly source: string;
  readonly resourceSource: string;
  readonly resolvedBy: string;
  readonly cwd: string;
  readonly existed: boolean;
  readonly before: TextDocument;
  readonly after: TextDocument;
  readonly intent: TextEditIntent;
}

export type TextEditCompletionListener = (completion: TextEditCompletion) => void | Promise<void>;

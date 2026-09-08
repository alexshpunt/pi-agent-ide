/**
Public API for extending umbrella text mutations and anchors.
*/
export * from "pi-agent-text-editor/api/connect-plugin";

export * from "pi-agent-text-editor/api/plugin-protocol";

export {
  connectTextEditorPostEditHandler,
  type TextPostEditTransaction,
  type TextPostEditStatusContribution,
} from "pi-agent-text-editor/api/post-edit";
export type { MutationDiffStatus } from "pi-agent-text-editor/api/mutation-result";

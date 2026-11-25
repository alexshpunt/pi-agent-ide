import type { TextEditorPluginApi } from "pi-agent-ide/api/text-editor";

type IdeHandler = Parameters<ReturnType<TextEditorPluginApi["tool"]>["addSemanticHandler"]>[0];
/** The shared Linear handlers need a verified snapshot, not the IDE's anchor engine. */
export interface LinearMutationContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly sourceDocument: { readonly content: string };
}
export interface LinearSemanticHandler {
  readonly matches: IdeHandler["matches"];
  readonly execute: (
    context: LinearMutationContext,
    input: unknown,
  ) => ReturnType<IdeHandler["execute"]>;
}

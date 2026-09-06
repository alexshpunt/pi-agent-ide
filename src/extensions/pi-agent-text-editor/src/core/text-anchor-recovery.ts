import type { TextEditorCore } from "#src/core/text-editor-core.js";
import type { ReadRequest, ReadToolResult } from "pi-agent-read/api/tools/read";
import type { ResourceResolverContext } from "pi-agent-resource";

export type TextAnchorRecoveryReader = (
  request: ReadRequest,
  context: ResourceResolverContext,
) => Promise<ReadToolResult>;

const readers = new WeakMap<TextEditorCore, TextAnchorRecoveryReader>();

export function setTextAnchorRecoveryReader(
  core: TextEditorCore,
  reader: TextAnchorRecoveryReader,
): void {
  readers.set(core, reader);
}

export function readTextAnchorRecovery(
  core: TextEditorCore,
  request: ReadRequest,
  context: ResourceResolverContext,
): Promise<ReadToolResult> | undefined {
  return readers.get(core)?.(request, context);
}

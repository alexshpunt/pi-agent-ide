import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export function guideAttachmentPrefix(id: string): string {
  return `\n\n---\n\n# Guide: ${id}\n\n`;
}

/** A display-only projection; leave the transcript and provider result untouched. */
export function withoutGuideAttachments(
  result: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  const details = result.details as
    | { documentation?: { kind?: unknown; ids?: unknown } }
    | undefined;
  const documentation = details?.documentation;
  if (documentation?.kind !== "attachment" || !Array.isArray(documentation.ids)) return result;

  const attached = new Set<number>();
  for (const id of documentation.ids as unknown[]) {
    if (typeof id !== "string") continue;
    const prefix = guideAttachmentPrefix(id);
    // Attachments come after the script output, which can itself contain the same heading.
    const index = result.content.findLastIndex(
      (block) => block.type === "text" && block.text.startsWith(prefix),
    );
    if (index !== -1) attached.add(index);
  }

  return attached.size === 0
    ? result
    : { ...result, content: result.content.filter((_block, index) => !attached.has(index)) };
}

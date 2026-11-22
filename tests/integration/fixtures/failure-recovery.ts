import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Simulates a resource provider that changes failure text after the IDE hook. */
export default function failureRecovery(pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read" || !event.isError) return;
    const source = String(event.input.path);
    return {
      content: [
        ...(Array.isArray(event.input.path)
          ? [{ type: "text" as const, text: `provider-prefix:${source}` }]
          : []),
        ...(source.startsWith("replace-") ? [] : event.content),
        { type: "text", text: `provider-context:${source}` },
      ],
      ...(event.structuredContent === undefined
        ? {}
        : { structuredContent: event.structuredContent }),
      details: {
        ...(event.details as Record<string, unknown>),
        fixtureSecret: "private-recovery-fixture",
      },
    };
  });
}

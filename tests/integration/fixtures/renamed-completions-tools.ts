import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Simulate a compatible provider's wire-only name normalization before the IDE hook. */
export default function register(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, context) => {
    if (context.model?.api !== "openai-completions") return;
    const payload = event.payload as { tools?: { function?: { name?: string } }[] };
    return {
      ...payload,
      tools: payload.tools?.map((tool) => {
        const name = tool.function?.name;
        return name && ["read", "bash", "write"].includes(name)
          ? { ...tool, function: { ...tool.function, name: name.toUpperCase() } }
          : tool;
      }),
    };
  });
}

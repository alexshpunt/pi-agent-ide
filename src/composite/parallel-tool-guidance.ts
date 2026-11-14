type ParallelToolFamily = "responses" | "completions" | "anthropic" | "neutral";

export function parallelToolFamily(api: unknown): ParallelToolFamily {
  switch (api) {
    case "openai-responses":
    case "openai-codex-responses":
    case "azure-openai-responses": {
      return "responses";
    }
    case "openai-completions": {
      return "completions";
    }
    case "anthropic-messages": {
      return "anthropic";
    }
    default: {
      return "neutral";
    }
  }
}

const mechanisms: Record<ParallelToolFamily, string> = {
  responses: "Use `multi_tool_use.parallel` to submit independent tool calls together.",
  completions: "Put independent calls in the same response's `tool_calls` array.",
  anthropic: "Put independent calls in multiple `tool_use` blocks in a single response.",
  neutral: "Submit independent tool calls together in a single response.",
};

export function buildParallelToolGuidance(api: unknown): string {
  return [
    "Before calling tools, plan ALL calls you can make without seeing another call's result.",
    "Batch independent calls, including reads of different files and edits to separate selections.",
    mechanisms[parallelToolFamily(api)],
    "Run calls in sequence only when a call needs an earlier result or their effects must be ordered; merge overlapping edits into one.",
    "Plan → issue one parallel batch → analyze results → repeat for newly discovered calls.",
    "Do not use shell scripts to parallelize IDE calls. In Codemode, use Promise.all for independent calls; keep dependent calls and edits to the same file in order.",
  ].join("\n");
}

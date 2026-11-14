import { parallelToolFamily } from "#src/composite/parallel-tool-guidance.ts";
import type { CapabilityCase } from "./validation.ts";

export { parallelToolFamily as parallelCallFormat };

/** Describe one independent direct batch using the selected API format. */
export function parallelCalls(api: string | undefined, count: number): string {
  const formats = {
    responses: "in one multi_tool_use.parallel call",
    completions: "in one assistant message's tool_calls array",
    anthropic: "as separate tool_use blocks in one assistant message",
    neutral: "in one assistant message before receiving any of their results",
  };
  return `Treat these ${count} calls as independent. Submit all ${count} direct calls together ${formats[parallelToolFamily(api)]}.`;
}

/** Render a case for the selected model API and execution route. */
export function capabilityPrompt(task: CapabilityCase, mode: string, api?: string): string {
  const body = task.promptForApi?.(api) ?? task.prompt;
  const route = task.steps
    .filter((step) => !step.modes || step.modes.includes(mode))
    .map((step) => step.tool)
    .join(" → ");
  return `This is a small tool capability check in a disposable fixture.\n${body}\nRequired execution route (in order; extra inspection is allowed): ${route}.\n${mode === "codemode" ? "Perform every requested IDE operation inside native Codemode. Keep tool results unchanged when passing them between calls." : "Use direct tool calls for the requested IDE operations, not Codemode."}\nUse the requested route, not shell/file-editing substitutes. Extra inspection is allowed. Do not modify unrelated files. Finish with a short factual answer.\n`;
}

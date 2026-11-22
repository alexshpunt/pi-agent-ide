import { getToolExecutions } from "pi-coding-agent-test";

/**
 * The readable results of a tool's calls made by scripts in a run, in call order, as a direct call
 * shows them. A script gets the tool's value instead.
 */
export function nestedResultTexts(run: Parameters<typeof getToolExecutions>[0], tool: string) {
  return getToolExecutions(run).flatMap(({ toolName, result }) =>
    toolName === tool
      ? [
          ((result as { content?: { type: string; text?: string }[] }).content ?? [])
            .map((block) => block.text ?? "")
            .join("\n"),
        ]
      : [],
  );
}

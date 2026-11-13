import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getProviderSystemPrompt,
  PiIntegrationTest,
  text,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";

const bashRule = "- Use bash for file operations like ls, rg, find";
const rules = (prompt: string): string[] => {
  const match = /^<rules>\n([\s\S]*?)\n<\/rules>$/mu.exec(prompt);
  if (!match?.[1]) throw new Error("System prompt has no rules section");
  return match[1].split("\n");
};

test.each([false, true])(
  "IDE preserves other rules when the prompt is forced: %s",
  async (forced) => {
    const root = path.resolve(".tmp/prompt-rules");
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "run-"));
    try {
      const result = await new PiIntegrationTest({
        testName: `prompt-rules-${forced}`,
        cwd,
        environment: { PROMPT_RULES_FORCE: forced ? "1" : "0" },
        extensions: [
          path.resolve("tests/integration/fixtures/prompt-rules-baseline.ts"),
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          "builtin:tool-search",
        ],
        conversation: [assistantMessage([text("Done")])],
      }).run("Continue.");
      const baseline = await readFile(path.join(cwd, "baseline-prompt.txt"), "utf8");
      const prompt = getProviderSystemPrompt(result);
      const before = rules(baseline);
      expect(before.filter((rule) => rule === bashRule)).toHaveLength(1);
      expect(rules(prompt)).toEqual(before.filter((rule) => rule !== bashRule));
      if (forced)
        expect(prompt).toBe(`${baseline.replace(`${bashRule}\n`, "")}\nfixture extension guidance`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);

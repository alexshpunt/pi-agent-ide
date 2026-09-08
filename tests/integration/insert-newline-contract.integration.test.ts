import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

for (const kind of ["hash", "exact", "multiline", "search-line", "search-match"]) {
  for (const before of [false, true]) {
    test(`insert newline contract ${kind} before=${before}`, async () => {
      const root = path.resolve(".agents/tmp/insert-newline-contract");
      await mkdir(root, { recursive: true });
      const cwd = await mkdtemp(path.join(root, "case-"));
      const separator = before ? "\r\n" : "\n";
      const original = ["BEFORE", "left ANCHOR right", "SECOND", "AFTER", ""].join(separator);
      const payloads = ["NEW", "\nNEW", "NEW\n\n"];
      const expected: string[] = [];
      const conversation = [];
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
      try {
        await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
        await writeFile(
          path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
          JSON.stringify({ noAnimations: true, noPostProcessing: true }),
        );
        for (const [index, payload] of payloads.entries()) {
          const file = `file-${index}.txt`;
          await writeFile(path.join(cwd, file), original);
          conversation.push(
            call(`read-${index}`, "read", { path: file, offset: 2, limit: 1, views: ["anchors"] }),
          );
          conversation.push(call(`search-${index}`, "search", { path: file, query: "ANCHOR" }));
          const anchor =
            kind === "hash"
              ? `LINE#RUNTIME:${index + 1}`
              : kind === "exact"
                ? "ANCHOR"
                : kind === "multiline"
                  ? `left ANCHOR right${separator}SECOND`
                  : `SEARCH#RUNTIME:${index + 1}:1:${kind === "search-line" ? "line" : "match"}`;
          conversation.push(
            call(`insert-${index}`, "insert", { path: file, anchor, before, text: payload }),
          );
          const lines = original.split(separator);
          const at = before ? 1 : kind === "multiline" ? 3 : 2;
          const inserted = payload.split("\n");
          if (inserted.at(-1) === "") inserted.pop();
          lines.splice(at, 0, ...inserted);
          expected.push(lines.join(separator));
        }
        conversation.push(assistantMessage([text("Done")]));
        const result = await new PiIntegrationTest({
          testName: `insert-${kind}-${before}`,
          artifactsDir: testArtifactsDir(import.meta.filename),
          cwd,
          tools: ["read", "search", "insert"],
          extensions: [
            path.resolve("src/pi-agent-ide.ts"),
            path.resolve(
              "tests/integration/extensions/pi-agent-text-editor/support/search-anchor-runtime-extension.ts",
            ),
          ],
          conversation,
        }).run("Apply the supplied insertions.");
        for (const [index, content] of expected.entries()) {
          expect(getToolExecution(result, `insert-${index}`).isError).toBe(false);
          expect(await readFile(path.join(cwd, `file-${index}.txt`), "utf8")).toBe(content);
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }, 120_000);
  }
}

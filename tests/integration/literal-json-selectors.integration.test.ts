import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

test("JSON object selector strings keep their text through direct tools and Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ noAnimations: true, noPostProcessing: true }),
    );
    const calls: Parameters<typeof toolCall>[0][] = [];
    const expected = new Map<string, string>();
    for (const route of ["direct", "script"])
      for (const multiline of [false, true])
        for (const indented of [false, true]) {
          const label = `${route}-${multiline}-${indented}`;
          const object = { id: "checkout-5", feature: "legacyCheckout", retries: 3 };
          const raw = JSON.stringify(object, null, multiline ? 2 : undefined);
          const selector = indented ? raw.replaceAll(/^/gm, "    ") : raw;
          const body = `[\n${selector},\n{"id":"keep"}\n]\n`;
          const steps: Parameters<typeof toolCall>[0][] = [];
          const call = (name: string, args: Record<string, string | boolean>) =>
            steps.push({ id: `${label}-${steps.length}`, name, arguments: args });
          for (const operation of ["replace", "insert", "copy"]) {
            const file =
              operation === "copy"
                ? JSON.stringify([`${label}-a.json`, `${label}-b.json`])
                : `${label}-${operation}.json`;
            await writeFile(path.join(cwd, file), body);
            call("read", { path: file });
            if (operation === "replace") {
              call("replace", {
                path: file,
                from: selector,
                through: selector,
                text: selector.replace("legacyCheckout", "stableCheckout"),
              });
              expected.set(file, body.replace("legacyCheckout", "stableCheckout"));
            } else if (operation === "insert") {
              call("insert", { path: file, anchor: selector, before: true, text: " " });
              expected.set(file, `[\n ${selector},\n{"id":"keep"}\n]\n`);
            } else {
              for (const peer of [`${label}-a.json`, `${label}-b.json`]) {
                await writeFile(path.join(cwd, peer), body);
                expected.set(peer, body);
              }
              const source = JSON.stringify({ id: `${label}-source`, feature: "fixture" });
              const sourceSelector = selector.replace("legacyCheckout", "stableCheckout");
              await writeFile(path.join(cwd, source), `[\n${sourceSelector}\n]\n`);
              call("read", { path: source });
              call("copy", {
                path: source,
                start: sourceSelector,
                end: sourceSelector,
                target: file,
                targetStart: selector,
                targetEnd: selector,
              });
              expected.set(file, body.replace("legacyCheckout", "stableCheckout"));
            }
          }
          if (route === "direct") calls.push(...steps);
          else
            calls.push({
              id: label,
              name: "codemode",
              arguments: {
                code: `for (const step of ${JSON.stringify(steps)}) {
  const value = await tools[step.name](step.arguments);
  if (value === null) throw Error("Failed fixture step " + step.id);
}
text("completed fixture steps");`,
              },
            });
        }
    const result = await new PiIntegrationTest({
      testName: "literal-json-selectors",
      cwd,
      rawMode: false,
      isolateUserResources: true,
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "replace", "insert", "copy", "codemode"],
      timeoutMs: 120000,
      conversation: calls
        .map((call) =>
          assistantMessage([
            toolCall({ ...call, chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } }),
          ]),
        )
        .concat([assistantMessage([text("Done.")])]),
    }).run("Edit the JSON fixtures with literal JSON selectors, preserving adjacent commas.");
    for (const call of calls) {
      expect(getToolExecution(result, call.id).isError, call.id).toBe(false);
      if (call.name === "codemode")
        expect(codemodeFailures(getToolResultText(result, call.id))).toBe("");
    }
    for (const [file, content] of expected) {
      const actual = await readFile(path.join(cwd, file), "utf8");
      expect(actual, file).toBe(content);
      expect(JSON.parse(actual), file).toEqual(JSON.parse(content));
    }
  });
}, 150000);

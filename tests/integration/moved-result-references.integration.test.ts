import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutions,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";

test("issued references follow a peer's block swap in a 26,240-line file", async () => {
  await withTempWorkspace(async (cwd) => {
    const first = Array.from({ length: 1800 }, (_, i) => `int first_${i};`);
    const second = Array.from({ length: 24440 }, (_, i) => `int second_${i};`);
    const needle = "old_symbol";
    const carrier = "int carry_this_line;";
    first[20] = carrier;
    for (let i = 0; i < 46; i += 1) {
      const block = i < 23 ? first : second;
      block[101 + 2 * i] = `int use_${i} = ${needle};`;
    }
    const file = (...blocks: string[][]) => `${blocks.flat().join("\n")}\n`;
    const after = file(second, first.with(101, `int peer_renamed_this_local = ${needle};`));
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
    );
    await writeFile(path.join(cwd, "main.cpp"), file(first, second));
    await writeFile(path.join(cwd, "peer-snapshot.cpp"), after);
    await writeFile(path.join(cwd, "sink.cpp"), "// destination\n");
    const call = (options: Parameters<typeof toolCall>[0]) =>
      assistantMessage([toolCall(options)], { stopReason: "toolUse" });
    const moveStart = '{"path":"main.cpp","start":"$issued-search:carrier:1"';
    const moveEnd = ',"target":"sink.cpp","targetStart":"// destination"}';
    const result = await new PiIntegrationTest({
      testName: "peer-block-swap-with-issued-results",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      timeoutMs: 120_000,
      rawMode: false,
      extensions: [
        path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
        path.resolve("src/pi-agent-ide.ts"),
      ],
      tools: ["search", "ast_search", "read", "replace", "move", "bash"],
      conversation: [
        call({
          id: "matches",
          name: "search",
          arguments: { path: "main.cpp", query: needle, limit: 46 },
        }),
        call({
          id: "carrier",
          name: "search",
          arguments: { path: "main.cpp", query: "carry_this_line" },
        }),
        call({
          id: "ast",
          name: "ast_search",
          arguments: { path: "main.cpp", pattern: carrier, language: "cpp" },
        }),
        call({ id: "peer", name: "bash", arguments: { command: "mv peer-snapshot.cpp main.cpp" } }),
        call({ id: "read-moved", name: "read", arguments: { path: "$issued-uuid:carrier" } }),
        call({ id: "read-ast", name: "read", arguments: { path: "$issued-uuid:ast" } }),
        call({
          id: "move-moved",
          name: "move",
          argumentsJson: moveStart + moveEnd,
          chunks: { kind: "explicit", chunks: [moveStart, moveEnd] },
          delayMs: 1,
        }),
        call({
          id: "replace-moved",
          name: "replace",
          arguments: {
            path: Array.from(
              { length: 46 },
              (_, index) => `$issued-searchmatch:matches:${index + 1}`,
            ),
            text: "new_symbol",
          },
          chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Use the issued selections after the peer changes the workspace");
    for (const id of [
      "matches",
      "carrier",
      "ast",
      "peer",
      "read-moved",
      "read-ast",
      "move-moved",
      "replace-moved",
    ])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    for (const id of ["read-moved", "read-ast"])
      expect(getToolResultText(result, id)).toContain("carry_this_line");
    expect(
      getToolExecutions(result).filter((entry) => entry.toolCallId === "move-moved"),
    ).toHaveLength(1);
    await expect(readFile(path.join(cwd, "main.cpp"), "utf8")).resolves.toBe(
      after.replace(`${carrier}\n`, "").replaceAll(needle, "new_symbol"),
    );
    await expect(readFile(path.join(cwd, "sink.cpp"), "utf8")).resolves.toBe(
      `// destination\n${carrier}\n`,
    );
  });
}, 180_000);

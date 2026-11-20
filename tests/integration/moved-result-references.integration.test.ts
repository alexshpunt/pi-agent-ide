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
    const needle = "CallMaxRoutine";
    const replacement = "CallMaxRoutineFunc";
    const pair = `inline OldVec ${needle}(const OldVec& a, float b) { return {${needle}(a.x, b), ${needle}(a.y, b)}; }`;
    const overload = `inline OldVec ${needle}(const OldVec& a, const OldVec& b) { return {${needle}(a.x, b.x), ${needle}(a.y, b.y)}; }`;
    const reduction = `inline float ${needle}(const OldVec& a) { return ${needle}(a.x, a.y); }`;
    first[450] = pair;
    first[451] = overload;
    first[452] = reduction;
    const carrier = "int carry_this_line;";
    first[20] = carrier;
    for (let i = 0; i < 44; i += 1) {
      const block = i < 23 ? first : second;
      block[101 + 2 * i] = `int use_${i} = ${needle};`;
    }
    const file = (...blocks: string[][]) => `${blocks.flat().join("\n")}\n`;
    const renamedType = (line: string) => line.replaceAll("OldVec", "NewVectorType");
    const after = file(
      second,
      first
        .with(101, `int peer_renamed_this_local = ${needle};`)
        .with(450, renamedType(pair))
        .with(451, renamedType(overload))
        .with(452, renamedType(reduction)),
    );
    // Keep the three overload declarations and the two vector-overload calls unchanged.
    const skipped = new Set([24, 27, 28, 29, 30]);
    const matches = Array.from({ length: 52 }, (_, index) => index + 1)
      .filter((index) => !skipped.has(index))
      .map((index) => `$issued-searchmatch:matches:${index}`);
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
    // A literal selects only its characters; the line break places the moved line after it. The
    // moved line carries its content, so the file then ends without a line break.
    const moveEnd = ',"target":"sink.cpp","targetStart":"// destination\\n"}';
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
          arguments: { path: "main.cpp", query: needle, limit: 52 },
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
            path: matches,
            text: replacement,
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
      after
        .replace(`${carrier}\n`, "")
        .replaceAll(`= ${needle};`, `= ${replacement};`)
        .replace(
          renamedType(pair),
          renamedType(pair).replaceAll(`${needle}(a.`, `${replacement}(a.`),
        )
        .replace(
          renamedType(reduction),
          renamedType(reduction).replace(`${needle}(a.`, `${replacement}(a.`),
        ),
    );
    await expect(readFile(path.join(cwd, "sink.cpp"), "utf8")).resolves.toBe(
      `// destination\n${carrier}`,
    );
  });
}, 180_000);

test("one rename keeps all 403 Search matches after a peer renames another type on the same lines", async () => {
  await withTempWorkspace(async (cwd) => {
    const source = "main.cpp";
    const original = "Vec2iType";
    const replacement = "Vector2i";
    const peerType = "ty_vec2f_t";
    const newPeerType = "Vector2Float";
    const tail = Array.from({ length: 1800 }, (_, i) => `int tail_${i};\n`).join("");
    const spacer = Array.from({ length: 2436 }, (_, i) => `int spacer_${i};\n`).join("");
    const lines = Array.from({ length: 403 }, (_, i) => {
      if (i >= 91) return `inline ${original} unchanged_${i}();\n`;
      const prefix = i % 2 === 0 ? `inline ${original}` : `inline pair<${peerType}, ${original}>`;
      const name = i === 0 ? "func_image_coords_func" : `convert_point_${i}`;
      return `${prefix} ${name}(const ${peerType}& MousePosArgument, const ${peerType}& center_arg);\n`;
    });
    const body = lines
      .map((line, i) => line + (i % 3 === 2 ? `// declaration group ${i}\n` : ""))
      .join("");
    const before = "struct Header;\n" + body + spacer + tail;
    const peer = tail + "struct Header;\n" + body.replaceAll(peerType, newPeerType) + spacer;
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
    );
    await writeFile(path.join(cwd, source), before);
    await writeFile(path.join(cwd, "peer-snapshot.cpp"), peer);
    const call = (options: Parameters<typeof toolCall>[0]) =>
      assistantMessage([toolCall(options)], { stopReason: "toolUse" });
    const run = await new PiIntegrationTest({
      testName: "peer-same-line-rename",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      timeoutMs: 120_000,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "replace", "bash", "codemode"],
      conversation: [
        call({
          id: "search",
          name: "codemode",
          arguments: {
            code: `const found = await tools.search({ path: "${source}", query: "${original}", wholeWord: true, limit: 1000 });
if (found?.complete !== true || found.matches.length !== 403) throw Error("Expected 403 matches");
store("matches", found.matches);`,
          },
        }),
        call({ id: "peer", name: "bash", arguments: { command: "mv peer-snapshot.cpp main.cpp" } }),
        call({
          id: "replace",
          name: "codemode",
          arguments: {
            code: `const result = await tools.replace({ path: load("matches"), text: "${replacement}" });
if (result === null) throw Error("Replace rejected the original matches");`,
          },
        }),
        assistantMessage([text("Done")]),
      ],
    }).run(
      "Rename one type using the original Search matches after a separate writer renames another type",
    );
    for (const id of ["search", "peer", "replace"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    await expect(readFile(path.join(cwd, source), "utf8")).resolves.toBe(
      peer.replaceAll(original, replacement),
    );
  });
}, 180_000);

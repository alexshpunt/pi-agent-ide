import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  FileMutationResult,
  type FileMutationBatchResult,
} from "pi-agent-text-editor/api/mutation-result";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import { expect, test } from "vitest";
import { createFixture, withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";

test("keeps all anchor rejection codes and private recovery details separate from native cards", async () => {
  await withTempWorkspace(async (cwd) => {
    const agentDirectory = path.join(cwd, ".pi-agent");
    await mkdir(path.join(agentDirectory, "pi-agent-ide"), { recursive: true });
    // Exercise the resolver rejection itself, before the optional stale preflight guard.
    await createFixture(
      agentDirectory,
      "pi-agent-ide/extensions.json",
      JSON.stringify({ disabled: ["editor.stale-anchor", "ide.lsp", "ide.lint", "ide.semantic"] }),
    );
    await createFixture(agentDirectory, "settings.json", JSON.stringify({ theme: "dark" }));
    const fixtures = {
      "missing.txt": "present\n",
      "ambiguous.txt": "same\nsame\n",
      "stale.txt": "current\n",
      "scope.txt": "first\nsecond\n",
    };
    for (const [file, content] of Object.entries(fixtures)) await createFixture(cwd, file, content);
    const calls = [
      { id: "scope", name: "read", arguments: { path: "scope.txt", offset: 1, limit: 1 } },
      {
        id: "invalid",
        name: "replace",
        arguments: {
          path: "$issued-uuid:scope",
          start: formatLineHashAnchor(fixtures["scope.txt"], 2),
          text: "changed",
        },
      },
      {
        id: "missing",
        name: "replace",
        arguments: { path: "missing.txt", start: "absent", text: "changed" },
      },
      {
        id: "ambiguous",
        name: "replace",
        arguments: { path: "ambiguous.txt", start: "same", text: "changed" },
      },
      {
        id: "stale",
        name: "replace",
        arguments: { path: "stale.txt", start: formatLineHashAnchor("old", 1), text: "changed" },
      },
    ];
    const result = await new PiIntegrationTest({
      testName: "anchor-rejection-cards",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      rawMode: false,
      isolateUserResources: false,
      extensions: [
        path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
        path.resolve("src/pi-agent-ide.ts"),
      ],
      environment: { PI_CODING_AGENT_DIR: agentDirectory },
      tools: ["read", "replace"],
      conversation: [
        ...calls.map((call) =>
          assistantMessage(
            [toolCall({ ...call, chunks: { kind: "fixed", size: 65536 }, delayMs: 0 })],
            { stopReason: "toolUse" },
          ),
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("Try the four rejected anchors without changing the files");
    for (const code of ["missing", "ambiguous", "invalid", "stale"]) {
      expect(getToolExecution(result, code).isError).toBe(true);
      const message = getToolResultMessage<FileMutationBatchResult>(result, code);
      const errors = message.details.results?.flatMap(
        (entry) => FileMutationResult.ensure(entry).data.errors ?? [],
      );
      expect(errors?.map((error) => error.code)).toEqual([code]);
      for (const error of errors ?? [])
        expect(result.tuiRenderedOutput).not.toContain(error.reason);
    }
    for (const [file, content] of Object.entries(fixtures))
      expect(await readFile(path.join(cwd, file), "utf8")).toBe(content);
  });
});

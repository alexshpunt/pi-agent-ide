import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test("native Codemode prepares and commits disjoint edits at the same time", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await Promise.all(
      ["first.txt", "second.txt"].map((name) => writeFile(path.join(cwd, name), "original")),
    );
    const result = await new PiIntegrationTest({
      testName: "native-independent-resource-preparation",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/resource-concurrency-probe.ts"),
      ],
      tools: ["concurrency_probe", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "concurrent-edits",
              name: "codemode",
              arguments: {
                code: `const results = await Promise.all([tools.concurrency_probe({path:"first.txt"}), tools.concurrency_probe({path:"second.txt"})]); results.forEach(text);`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Prepare independent native editor calls concurrently");
    expect(getToolExecution(result, "concurrent-edits").isError).toBe(false);
    expect(await readFile(path.join(cwd, "first.txt"), "utf8")).toBe("updated:first.txt");
    expect(await readFile(path.join(cwd, "second.txt"), "utf8")).toBe("updated:second.txt");
    const events: unknown = JSON.parse(
      await readFile(path.join(cwd, "concurrency-events.json"), "utf8"),
    );
    expect(events).toEqual([
      expect.stringMatching(/^enter:(first|second)\.txt$/u),
      expect.stringMatching(/^enter:(first|second)\.txt$/u),
      "plan:second.txt",
      "plan:first.txt",
      expect.stringMatching(/^write:enter:(first|second)\.txt$/u),
      expect.stringMatching(/^write:enter:(first|second)\.txt$/u),
      expect.stringMatching(/^write:complete:(first|second)\.txt$/u),
      expect.stringMatching(/^write:complete:(first|second)\.txt$/u),
    ]);
    expect(events).toEqual(
      expect.arrayContaining([
        "enter:first.txt",
        "enter:second.txt",
        "write:enter:first.txt",
        "write:enter:second.txt",
        "write:complete:first.txt",
        "write:complete:second.txt",
      ]),
    );
  });
});

test.each([false, true])(
  "native Codemode overlaps Read/Search with writer reservation=%s",
  async (holdWriter) => {
    await withTempWorkspace(async (cwd) => {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ codemode: { mode: "on" } }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
      );
      const result = await new PiIntegrationTest({
        testName: `native-independent-read-search-${holdWriter ? "writer" : "readers"}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        cwd,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          "builtin:codemode",
          path.resolve("tests/integration/fixtures/read-search-concurrency-probe.ts"),
        ],
        tools: ["read", "search", "hold_resource", "codemode"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "concurrent-read-search",
                name: "codemode",
                arguments: {
                  code: `${holdWriter ? "await tools.hold_resource({});" : ""} const results = await Promise.all([tools.read({path:"concurrency:first"}), tools.search({query:"concurrency:second"})]); for (const result of results) { if (result.status !== "success") throw new Error(JSON.stringify(result)); text(result); }`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Read and Search independent resources at the same time");
      expect(getToolExecution(result, "concurrent-read-search").isError).toBe(false);
      const events: unknown = JSON.parse(
        await readFile(path.join(cwd, "read-search-events.json"), "utf8"),
      );
      expect(events).toEqual(
        holdWriter
          ? ["writer:enter", "search:enter", "read:enter", "read:complete"]
          : ["read:enter", "search:enter", "read:complete"],
      );
    });
  },
);

test("independent standalone replacements commit concurrently through real Pi", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
    );
    await Promise.all(
      ["first.txt", "second.txt"].map((name) => writeFile(path.join(cwd, name), "original")),
    );
    const result = await new PiIntegrationTest({
      testName: "independent-standalone-commits",
      artifactsDir: testArtifactsDir(import.meta.filename),
      rawMode: false,
      cwd,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        "builtin:codemode",
        path.resolve("tests/integration/fixtures/resource-concurrency-probe.ts"),
      ],
      tools: ["replace"],
      conversation: [
        assistantMessage(
          ["first.txt", "second.txt"].map((name) =>
            toolCall({
              id: `replace-${name}`,
              name: "replace",
              arguments: {
                path: name,
                start: "original",
                text: `updated:${name}`,
              },
            }),
          ),
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Commit independent standalone replacements concurrently");
    expect(getToolExecution(result, "replace-first.txt").isError).toBe(false);
    expect(getToolExecution(result, "replace-second.txt").isError).toBe(false);
    expect(await readFile(path.join(cwd, "first.txt"), "utf8")).toBe("updated:first.txt");
    expect(await readFile(path.join(cwd, "second.txt"), "utf8")).toBe("updated:second.txt");
  });
});

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

const extensions = [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"];

async function configureWorkspace(cwd: string) {
  const config = path.join(cwd, ".pi/pi-agent-ide");
  await mkdir(config, { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  await writeFile(
    path.join(config, "extensions.json"),
    JSON.stringify({
      noAnimations: true,
      noPostProcessing: true,
      disabled: ["ide.lsp", "ide.lint", "ide.formatter"],
    }),
  );
}

const edits = [
  ["replace", { path: "replace.txt", at: "// ⟦SLOT⟧", text: "// ⟦kept⟧" }],
  ["insert", { path: "insert.txt", before: "⟦edge⟧", text: "inside " }],
  ["delete", { path: "delete.txt", after: "⟦BEGIN⟧", before: "⟦END⟧" }],
  [
    "copy",
    {
      path: "source.txt",
      from: "⟦START⟧",
      through: "⟦STOP⟧",
      target: "copy.txt",
      targetFrom: "⟦OPEN⟧",
      targetThrough: "⟦CLOSE⟧",
    },
  ],
  [
    "move",
    {
      path: "move.txt",
      at: "⟦TRANSFER⟧",
      target: "move-target.txt",
      targetAfter: "⟦LEFT⟧",
      targetBefore: "⟦RIGHT⟧",
    },
  ],
  ["copy", { path: "other.txt", at: "⟦ALPHA⟧", target: "copy-at.txt", targetAt: "⟦SLOT⟧" }],
  ["copy", { path: "other.txt", at: "⟦ALPHA⟧", target: "copy-after.txt", targetAfter: "⟦PREFIX⟧" }],
  [
    "copy",
    { path: "other.txt", at: "⟦ALPHA⟧", target: "copy-before.txt", targetBefore: "⟦SUFFIX⟧" },
  ],
  ["replace", { path: "literal.txt", at: "⟦SLOT⟧", text: "matched" }],
] as const;

const fixtures = [
  ["replace.txt", "// SLOT\n", "// ⟦kept⟧\n"],
  ["insert.txt", "left edge right\n", "left inside edge right\n"],
  ["delete.txt", "BEGIN\nold\nEND\n", "BEGIN\nEND\n"],
  ["source.txt", "START\nbody\nSTOP\n", "START\nbody\nSTOP\n"],
  ["copy.txt", "OPEN\nold\nCLOSE\n", "START\nbody\nSTOP\n"],
  ["move.txt", "keep\nTRANSFER\n", "keep\n"],
  ["move-target.txt", "LEFT\nold\nRIGHT\n", "LEFT\nTRANSFER\nRIGHT\n"],
  ["other.txt", "ALPHA\n", "ALPHA\n"],
  ["copy-at.txt", "left SLOT right\n", "left ALPHA right\n"],
  ["copy-after.txt", "PREFIX\n", "PREFIX\nALPHA\n"],
  ["copy-before.txt", "SUFFIX\n", "ALPHA\nSUFFIX\n"],
  ["literal.txt", "SLOT\n⟦SLOT⟧\n", "SLOT\nmatched\n"],
  ["ambiguous.txt", "SLOT\nSLOT\n", "SLOT\nSLOT\n"],
  ["missing.txt", "unrelated\n", "unrelated\n"],
] as const;

test.each(["direct", "codemode"] as const)(
  "pasted search highlight selectors work through %s",
  async (route) => {
    await withTempWorkspace(async (cwd) => {
      await configureWorkspace(cwd);
      for (const [name, before] of fixtures) await writeFile(path.join(cwd, name), before);
      const search = toolCall({
        id: "search",
        name: "search",
        arguments: { path: "replace.txt", query: "SLOT" },
      });
      const calls =
        route === "direct"
          ? edits.map(([name, args], index) =>
              toolCall({ id: `edit-${index}`, name, arguments: args }),
            )
          : [
              toolCall({
                id: "edit-script",
                name: "codemode",
                arguments: {
                  code: `await Promise.all(${JSON.stringify(edits)}.map(([name, args]) => tools[name](args)));`,
                },
              }),
            ];
      const refusals = ["ambiguous.txt", "missing.txt"];
      const rejected =
        route === "direct"
          ? refusals.map((path, index) =>
              toolCall({
                id: `refuse-${index}`,
                name: "replace",
                arguments: { path, at: "⟦SLOT⟧", text: "wrong" },
              }),
            )
          : [
              toolCall({
                id: "refuse-script",
                name: "codemode",
                arguments: {
                  code: `text(await Promise.all(${JSON.stringify(refusals)}.map(path => tools.replace({path, at: "⟦SLOT⟧", text: "wrong"}))));`,
                },
              }),
            ];
      const result = await new PiIntegrationTest({
        testName: `search-highlight-selectors-${route}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        tools: ["search", "replace", "insert", "delete", "copy", "move", "codemode"],
        extensions,
        isolateUserResources: true,
        timeoutMs: 45000,
        conversation: [
          assistantMessage([search], { stopReason: "toolUse" }),
          assistantMessage(calls, { stopReason: "toolUse" }),
          assistantMessage(rejected, { stopReason: "toolUse" }),
          assistantMessage([text("Done.")]),
        ],
      }).run("Apply the selected edits.");
      expect(getToolResultText(result, "search")).toContain("// ⟦SLOT⟧");
      for (const id of route === "direct"
        ? edits.map((_, index) => `edit-${index}`)
        : ["edit-script"]) {
        const output = getToolResultText(result, id);
        expect(getToolExecution(result, id).isError, output).toBe(false);
        if (id === "edit-script") expect(codemodeFailures(output)).toBe("");
        if (id !== "edit-8") expect(output).toContain("⟦ ⟧");
        else expect(output).not.toContain("⟦ ⟧");
      }
      for (const id of route === "direct" ? ["refuse-0", "refuse-1"] : ["refuse-script"]) {
        const output = getToolResultText(result, id);
        expect(output).toContain("⟦ ⟧");
        if (id === "refuse-script") {
          expect(codemodeFailures(output)).toContain("ambiguous.txt");
          expect(codemodeFailures(output)).toContain("missing.txt");
        } else expect(getToolExecution(result, id).isError).toBe(true);
      }
      for (const file of refusals) {
        const screen = result.tuiRenderedOutput;
        const panel = screen.lastIndexOf(`replace ${file}`);
        expect(panel).toBeGreaterThanOrEqual(0);
        expect(screen.slice(panel).split("\n").slice(0, 6).join("\n")).toContain("⟦ ⟧");
      }
      for (const [name, , expected] of fixtures)
        expect(await readFile(path.join(cwd, name), "utf8"), name).toBe(expected);
    });
  },
  60000,
);
test("a real bracketed match wins across a multi-file Search scope", async () => {
  await withTempWorkspace(async (cwd) => {
    await configureWorkspace(cwd);
    await writeFile(path.join(cwd, "bracketed.txt"), "⟦SLOT⟧\n");
    await writeFile(path.join(cwd, "plain.txt"), "SLOT\n");
    const result = await new PiIntegrationTest({
      testName: "search-highlight-scoped-precedence",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      tools: ["search", "replace", "codemode"],
      extensions,
      isolateUserResources: true,
      timeoutMs: 45000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "scoped",
              name: "codemode",
              arguments: {
                code: `const found = await tools.search({path: ".", query: "regex:.*SLOT.*", include: "*.txt"});
await tools.replace({path: found, at: "⟦SLOT⟧", text: "UPDATED"});`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done.")]),
      ],
    }).run("Edit the uniquely selected file.");
    const output = getToolResultText(result, "scoped");
    expect(getToolExecution(result, "scoped").isError, output).toBe(false);
    expect(codemodeFailures(output)).toBe("");
    expect(output).not.toContain("⟦ ⟧");
    expect(await readFile(path.join(cwd, "bracketed.txt"), "utf8")).toBe("UPDATED\n");
    expect(await readFile(path.join(cwd, "plain.txt"), "utf8")).toBe("SLOT\n");
  });
}, 60000);

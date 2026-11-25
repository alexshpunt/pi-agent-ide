import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { githubPackageRoot } from "./fixtures/package-root.ts";
import { currentIde } from "./fixtures/current-ide.ts";

interface GithubFixtureJournal {
  issues: Record<string, { body: string }>;
  requests: { path: string; method: string }[];
}

const root = githubPackageRoot;
const fixture = path.join(root, "tests/fixtures/provider.ts");

test.each([false, true])(
  "Codemode returns the source of a created GitHub resource (providerFirst=%s)",
  async (providerFirst) => {
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/github-action-receipt-"));
    try {
      await writeFile(
        path.join(cwd, "github-fixture.json"),
        JSON.stringify({ issues: { "12": {} }, comments: [], requests: [], sequence: 0 }),
      );
      const ide = await currentIde();
      const result = await new PiIntegrationTest({
        testName: `github-action-receipt-${providerFirst}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        timeoutMs: 60_000,
        extensions: [
          ...(providerFirst ? [fixture, ide.extension] : [ide.extension, fixture]),
          "builtin:codemode",
        ],
        tools: ["read", "write", "codemode"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "action",
                name: "codemode",
                arguments: {
                  code: `
const receipt = await tools.write({ path: "github://example/project/issues/new", content: JSON.stringify({title: "Codemode fixture", body: "Readable receipt"}) });
if (!receipt || receipt.source !== "github://example/project/issues/99" || Object.keys(receipt).join() !== "source") throw Error("Invalid receipt: " + JSON.stringify(receipt));
const created = await tools.read({path: receipt.source});
if (!created || !created.text.includes("Readable receipt")) throw Error("Created resource could not be read");
text("action receipt OK");`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Create and inspect the fixture issue.");
      const output = getToolResultText(result, "action");
      expect(getToolExecution(result, "action").isError, output).toBe(false);
      expect(output).toContain("action receipt OK");
      const state = JSON.parse(
        await readFile(path.join(cwd, "github-fixture.json"), "utf8"),
      ) as GithubFixtureJournal;
      expect(state.issues["99"].body).toBe("Readable receipt");
      expect(
        state.requests.filter((request: { method: string }) => request.method === "POST"),
      ).toHaveLength(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90_000,
);

import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

const root = githubPackageRoot;
// Pattern: the existing provider HTTP fixture and the public real-Pi extension example.
// Contract: typed Discussion bodies use the selected surface and keep nested scopes bounded.
test.each([false, true])(
  "Discussion bodies stay bounded through Codemode (standalone=%s)",
  async (standalone) => {
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/discussion-mode-"));
    try {
      const ide = await currentIde();
      const fixture = path.join(root, "tests/fixtures/discussion-provider.ts");
      const read = standalone ? "github_read" : "read";
      const search = standalone ? "github_search" : "search";
      const result = await new PiIntegrationTest({
        testName: "discussion-mode-" + (standalone ? "standalone" : "ide"),
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: [...(standalone ? [] : [ide.extension]), fixture, "builtin:codemode"],
        tools: [read, search, "codemode"],
        timeoutMs: 60_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "discussion",
                name: read,
                arguments: { path: "github://owner/repo/discussions/3#body" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "scope",
                name: "codemode",
                arguments: {
                  code: `const one = await tools.${read}({path:"github://owner/repo/discussions/3#body",offset:1,limit:1}); if (!one || one.text !== "Discussion first\\n") throw Error("Unexpected Read value"); const result = await tools.${search}({path:one,query:"Discussion last"}); if (!result || !result.complete || result.matches.length !== 0) throw Error("Search escaped the selection"); text("Scoped search stayed bounded");`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Read this explicit Discussion body and keep the selected first line bounded.");
      for (const id of ["discussion", "scope"])
        expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      expect(getToolResultText(result, "discussion")).toContain(
        "Discussion first\nDiscussion last",
      );
      expect(getToolResultText(result, "scope")).toContain("Scoped search stayed bounded");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90_000,
);

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

test("projection failure resolves to null without exposing the private record", async () => {
  await withTempWorkspace(async (cwd) => {
    await writeFile(path.join(cwd, "fixture.txt"), "private fixture content\n");
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    const run = await new PiIntegrationTest({
      testName: "projection-failure",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        "builtin:codemode",
        path.resolve("tests/integration/support/projection-failure.ts"),
      ],
      tools: ["fixture", "codemode"],
      conversation: [
        assistantMessage([toolCall({ id: "direct", name: "fixture", arguments: {} })], {
          stopReason: "toolUse",
        }),
        assistantMessage(
          [
            toolCall({
              id: "script",
              name: "codemode",
              arguments: { code: "text(JSON.stringify(await tools.fixture({})));" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Read the fixture");
    expect(getToolResultText(run, "direct")).toContain("private fixture content");
    const result = getToolResultText(run, "script");
    expect(result).toContain("null");
    expect(result).toContain("projection fixture failure");
    expect(result).not.toContain("private fixture content");
  });
}, 60_000);

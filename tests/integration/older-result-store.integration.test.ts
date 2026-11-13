import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@earendil-works/pi-ai";
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

interface Step {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, JsonValue>;
}

test("result scopes work when an extension with an older SDK created the shared store", async () => {
  await withTempWorkspace(async (cwd) => {
    await mkdir(path.join(cwd, ".pi-agent"));
    await writeFile(
      path.join(cwd, "app.ts"),
      "export const alpha = 1;\nexport const beta = alpha;\n",
    );
    const steps: Step[] = [
      { id: "read", name: "read", arguments: { path: "app.ts" } },
      { id: "text", name: "search", arguments: { path: "$issued-uuid:read", query: "alpha" } },
      {
        id: "ast",
        name: "ast_search",
        arguments: { path: "$issued-uuid:read", pattern: "alpha" },
      },
      {
        id: "replace",
        name: "replace",
        arguments: { path: "$issued-searchallmatch:text", text: "gamma" },
      },
    ];
    const result = await new PiIntegrationTest({
      testName: "older-result-store",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      transport: "rpc",
      rawMode: false,
      environment: { PI_CODING_AGENT_DIR: path.join(cwd, ".pi-agent") },
      extensions: [
        path.resolve("tests/integration/fixtures/issued-reference-provider.ts"),
        // Loads before the IDE, like pi-agent-github with its bundled SDK 0.9.8.
        path.resolve("tests/integration/fixtures/older-result-store.ts"),
        path.resolve("src/pi-agent-ide.ts"),
      ],
      tools: ["read", "search", "ast_search", "replace"],
      conversation: [
        ...steps.map((step) =>
          assistantMessage([toolCall({ ...step, delayMs: 0 })], { stopReason: "toolUse" }),
        ),
        assistantMessage([text("Done", { delayMs: 0 })]),
      ],
    }).run("Search inside a Read result.");
    for (const step of steps)
      expect(getToolExecution(result, step.id).isError, getToolResultText(result, step.id)).toBe(
        false,
      );
    expect(getToolResultText(result, "text")).toContain("2 matches in 1 file");
    expect(getToolResultText(result, "ast")).toContain("app.ts:2");
  });
}, 180_000);

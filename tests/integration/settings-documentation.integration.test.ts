import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, afterEach, expect, test } from "vitest";
import { AGENT_IDE_PREFERENCES } from "#src/composite/preferences.js";
import { AGENT_IDE_PRESET_OPTIONS } from "#src/composite/presets.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";

const extension = process.env.PI_AGENT_IDE_TEST_EXTENSION ?? path.resolve("src/pi-agent-ide.ts");
const workspaces: string[] = [];
const restoreRuntime = forceStandaloneIntegrationFile();
afterAll(restoreRuntime);
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((cwd) => rm(cwd, { recursive: true, force: true })));
});

async function workspace() {
  const cwd = await mkdtemp(path.join(tmpdir(), "ide-settings-docs-"));
  workspaces.push(cwd);
  return cwd;
}

async function run(
  cwd: string,
  mode: "direct" | "codemode",
  calls: { id: string; name: string; arguments: Record<string, unknown> }[],
) {
  return new PiIntegrationTest({
    testName: `ide-settings-${mode}`,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    extensions: [extension, ...(mode === "codemode" ? ["builtin:codemode"] : [])],
    tools: ["read", "search", ...(mode === "codemode" ? ["codemode"] : [])],
    environment: { PI_AGENT_IDE_TEST_SKIP_GUIDE_PRELOAD: "1" },
    conversation: [
      ...calls.map((call) =>
        assistantMessage(
          [
            toolCall(
              mode === "direct"
                ? call
                : {
                    id: call.id,
                    name: "codemode",
                    arguments: {
                      code: `text(await tools.${call.name}(${JSON.stringify(call.arguments)}));`,
                    },
                  },
            ),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Done")]),
    ],
  }).run("Read and search the registered IDE settings catalog");
}

function resultText(result: Awaited<ReturnType<typeof run>>, id: string) {
  return getToolResultMessage(result, id)
    .content.filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

test.each(["direct", "codemode"] as const)(
  "reads and searches registered settings through %s",
  async (mode) => {
    const result = await run(await workspace(), mode, [
      { id: "catalog", name: "read", arguments: { path: "docs:ide-settings", limit: 1000 } },
      {
        id: "scoped",
        name: "search",
        arguments: { path: "docs:ide-settings", query: "ui.codemode", limit: 3 },
      },
      {
        id: "all",
        name: "search",
        arguments: { path: "docs:all", query: "ui.codemode", limit: 3 },
      },
    ]);
    expect(getToolExecution(result, "catalog").isError).toBe(false);
    const json = resultText(result, "catalog").match(/```json\n([\s\S]*?)\n```/)?.[1];
    if (json === undefined) throw new Error("Missing structured settings catalog");
    const catalog = JSON.parse(json) as {
      preferences: unknown[];
      presets: unknown[];
      flags: { id: string; default: boolean }[];
    };
    expect(catalog.preferences).toEqual(AGENT_IDE_PREFERENCES);
    expect(catalog.presets).toEqual(AGENT_IDE_PRESET_OPTIONS);
    expect(catalog.flags.find(({ id }) => id === "pi-agent-ide-vision-displays")?.default).toBe(
      false,
    );
    for (const id of ["scoped", "all"]) {
      expect(getToolExecution(result, id).isError).toBe(false);
      expect(resultText(result, id)).toMatch(/docs:ide-settings:\d+:/);
      expect(resultText(result, id)).not.toContain("SEARCH#");
    }
  },
);

test("does not enable a disabled documentation provider to publish the catalog", async () => {
  const cwd = await workspace();
  const configPath = path.join(cwd, ".pi", "pi-agent-ide", "extensions.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  const config = JSON.stringify({ disabled: ["ide.documentation"], custom: "preserved" });
  await writeFile(configPath, config);
  const result = await run(cwd, "direct", [
    { id: "disabled", name: "read", arguments: { path: "docs:ide-settings" } },
  ]);
  expect(getToolExecution(result, "disabled").isError).toBe(true);
  expect(await readFile(configPath, "utf8")).toBe(config);
});

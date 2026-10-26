import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

const entry = path.resolve("src/pi-agent-ide.ts");
const plugin = path.resolve("tests/integration/fixtures/read-schema-plugin.ts");
const root = path.resolve(".tmp/read-schema-tests");

async function schema(disabled: string[], latePlugin = false) {
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(path.join(root, "workspace-"));
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ disabled }),
    );
    const result = await new PiIntegrationTest({
      testName: latePlugin ? "read-schema-late" : "read-schema-disabled",
      artifactsDir: path.join(root, "artifacts"),
      cwd,
      piCommand: process.env.PI_COMMAND ?? "pi",
      rawMode: false,
      isolateUserResources: true,
      extensions: [entry, ...(latePlugin ? [plugin] : [])],
      tools: ["read"],
      conversation: [assistantMessage([text("Captured.")])],
    }).run("Inspect the declared Read schema");
    const read = getCurrentTools(result.providerRequests[0]?.messages as Message[]).find(
      (tool) => tool.name === "read",
    );
    if (read === undefined) throw new Error("Read was not declared");
    return read.parameters as {
      properties: Record<string, { description: string; type: string; items?: { type: string } }>;
    };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("delivers late plugin metadata to the real Pi provider", async () => {
  const read = await schema([], true);
  const { path: source, views } = read.properties;
  expect(source?.description).toContain("current-schema-format");
  expect(source?.description).not.toContain("old-schema-format");
  expect(views?.description).toContain("late-view");
  expect(views).toMatchObject({ type: "array", items: { type: "string" } });
});

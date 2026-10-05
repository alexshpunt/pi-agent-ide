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
      JSON.stringify({ disabled, preferences: { "vision.imageScale": "0.75" } }),
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

test("delivers loaded source/view contracts and late metadata to the real Pi provider", async () => {
  const read = await schema(["ide.terminal"], true);
  const { path: source, views, offset, limit } = read.properties;
  expect(source?.description).toContain("current-schema-format");
  expect(source?.description).not.toContain("old-schema-format");
  for (const prefix of [
    "file://",
    "HTTP(S)",
    "docs:",
    "raw:",
    "temp:",
    "SEARCH#",
    "RESULT#",
    "symbol:",
    "graph:",
    "ast:",
    "diagnostics:",
    "debug:",
    "window:",
  ])
    expect(source?.description).toContain(prefix);
  for (const view of [
    "anchors",
    "ast",
    "changes",
    "diagnostics",
    "breakpoints",
    "jq:<filter>",
    "image:scale",
    "sequence:duration",
    "late-view",
  ])
    expect(views?.description).toContain(view);
  expect(views?.description).toContain("scale=0.75");
  expect(views?.description).toContain("cannot be combined");
  expect(offset?.description).toContain("row-major");
  expect(limit?.description).toContain("output pixels");
  expect(source?.description).not.toContain("shell:<session>");
  expect(views).toMatchObject({ type: "array", items: { type: "string" } });
});

test("does not advertise disabled plugin syntax in the real Pi schema", async () => {
  const read = await schema([
    "ide.terminal",
    "ide.vision",
    "ide.ast",
    "ide.changes",
    "ide.debugger",
    "ide.diagnostics",
    "ide.lsp",
    "read.web",
    "read.filesystem.jq",
    "editor.anchor.line-hash",
  ]);
  const { path: source, views, offset, limit } = read.properties;
  for (const prefix of [
    "HTTP(S)",
    "window:",
    "shell:",
    "symbol:",
    "graph:",
    "ast:",
    "debug:",
    "diagnostics:",
  ])
    expect(source?.description).not.toContain(prefix);
  for (const view of [
    "anchors —",
    "ast —",
    "changes —",
    "breakpoints —",
    "jq:<filter>",
    "image:scale",
    "sequence:duration",
  ])
    expect(views?.description).not.toContain(view);
  expect(offset?.description).not.toContain("row-major");
  expect(limit?.description).not.toContain("output pixels");
  expect(source?.description).toContain("File path");
  expect(source?.description).toContain("raw:");
});

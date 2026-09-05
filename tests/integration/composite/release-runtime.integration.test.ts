import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createPdfFixture } from "#test-fixtures/pdf";

const installation = process.env.PI_AGENT_IDE_TEST_INSTALLATION;
const sourceEntry = path.resolve("src/pi-agent-ide.ts");

describe.skipIf(installation === undefined)("installed release runtime", () => {
  let directory = "";
  let entry: string;
  let probe: string;
  let url: string;
  const server = createServer((_request, response) => {
    if (_request.url?.endsWith("/browser") && !_request.headers["user-agent"]?.includes("Chrome")) {
      response.writeHead(503);
      response.end("Use the browser fallback");
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(
      "<!doctype html><html><head><title>Package page</title></head><body><article><h1>Release page marker</h1><p>This local article proves that the installed extension can extract useful text from an HTML document.</p><p>This second paragraph supplies enough ordinary content for the reader.</p></article><script>document.querySelector('h1').textContent='Browser release marker';</script></body></html>",
    );
  });

  beforeAll(async () => {
    if (installation === undefined) return;
    const root = path.resolve(installation);
    // Keep the fixture outside the source checkout so bare API imports resolve only
    // through the installed package. Its node_modules directory is in root.
    await mkdir(path.join(root, ".agents/tmp"), { recursive: true });
    directory = await mkdtemp(path.join(root, ".agents/tmp/runtime-"));
    const manifest = JSON.parse(
      await readFile(path.join(root, "node_modules/pi-agent-ide/package.json"), "utf8"),
    ) as { pi: { extensions: string[] } };
    const extension = manifest.pi.extensions.at(0);
    if (extension === undefined) throw new Error("Missing installed extension entry");
    entry = path.resolve(root, "node_modules/pi-agent-ide", extension);
    probe = path.join(directory, "release-probe.ts");
    await copyFile(path.resolve("tests/integration/composite/support/release-probe.ts"), probe);
    await writeFile(
      path.join(directory, "example.ts"),
      "export function startupMarker() { return 7; }\n",
    );
    await writeFile(path.join(directory, "edit.txt"), "before marker\n");
    await writeFile(path.join(directory, "example.pdf"), createPdfFixture(["PDF release marker"]));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port");
    url = `http://127.0.0.1:${address.port}/article`;
  });

  afterAll(async () => {
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    if (directory.length > 0) await rm(directory, { recursive: true, force: true });
  });

  test("installed runtime keeps core tools, resources, and first-use optional capabilities", async () => {
    const calls = [
      { id: "read", name: "read", arguments: { path: "example.ts" } },
      { id: "ast", name: "read", arguments: { path: "ast:example.ts" } },
      { id: "search", name: "search", arguments: { query: "startupMarker", path: "example.ts" } },
      {
        id: "edit",
        name: "replace",
        arguments: { path: "edit.txt", start: "before", text: "after" },
      },
      { id: "pdf-first", name: "read", arguments: { path: "example.pdf" } },
      { id: "pdf-next", name: "read", arguments: { path: "example.pdf" } },
      { id: "html", name: "read", arguments: { path: url } },
      { id: "browser", name: "read", arguments: { path: `${url}/browser` } },

      { id: "html-next", name: "read", arguments: { path: url } },
      { id: "browser-next", name: "read", arguments: { path: `${url}/browser` } },
      { id: "config", name: "package_config_probe", arguments: {} },
    ];
    const result = await new PiIntegrationTest({
      testName: "installed-runtime-contract",

      rawMode: false,

      piCommand: process.env.PI_COMMAND,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: directory,
      extensions: [entry, probe],
      isolateUserResources: true,
      tools: ["read", "search", "replace", "package_config_probe"],
      conversation: [
        ...calls.map((call) => assistantMessage([toolCall(call)], { stopReason: "toolUse" })),
        assistantMessage([text("Done")]),
      ],
    }).run("Exercise the installed package");
    for (const call of calls)
      expect(getToolExecution(result, call.id).isError, getToolResultText(result, call.id)).toBe(
        false,
      );
    expect(getToolResultText(result, "ast")).toContain("startupMarker");
    expect(getToolResultText(result, "search")).toContain("startupMarker");
    expect(await readFile(path.join(directory, "edit.txt"), "utf8")).toBe("after marker\n");
    for (const id of ["pdf-first", "pdf-next"])
      expect(getToolResultText(result, id)).toContain("PDF release marker");
    expect(getToolResultText(result, "html")).toContain("Release page marker");
    expect(getToolResultText(result, "browser")).toContain("Browser release marker");

    expect(getToolResultText(result, "html-next")).toContain("Release page marker");
    expect(getToolResultText(result, "browser-next")).toContain("Browser release marker");
    const config = JSON.parse(getToolResultText(result, "config")) as {
      paths: string[];
      configs: { version: number }[];
    };
    expect(
      config.paths.every((file) =>
        file.startsWith(path.resolve(installation ?? "", "node_modules/pi-agent-ide")),
      ),
    ).toBe(true);
    expect(config.configs).toHaveLength(3);
    expect(config.configs.every((value) => value.version === 1)).toBe(true);
  });

  test.each([false, true])(
    "external plugin works across reload (plugin first: %s)",
    async (pluginFirst) => {
      const result = await new PiIntegrationTest({
        testName: `installed-plugin-reload-${pluginFirst}`,

        rawMode: false,

        piCommand: process.env.PI_COMMAND,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: directory,
        extensions: pluginFirst ? [probe, entry] : [entry, probe],
        isolateUserResources: true,
        tools: ["search"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "external",
                name: "search",
                arguments: { query: "external:package" },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("/package-reload");
      expect(getToolExecution(result, "external").isError).toBe(false);
      expect(getToolResultText(result, "external")).toContain("external package connected");
    },
  );

  test("installed runtime preserves the source tool catalog", async () => {
    const catalogs: unknown[] = [];
    for (const extension of [sourceEntry, entry]) {
      const result = await new PiIntegrationTest({
        testName: extension === entry ? "installed-prompt" : "source-prompt",

        rawMode: false,

        piCommand: process.env.PI_COMMAND,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: directory,
        extensions: [extension, probe],
        isolateUserResources: true,
        tools: [
          "read",
          "search",
          "replace",
          "insert",
          "delete",
          "copy",
          "move",
          "undo",
          "stage",
          "unstage",
          "write",

          "tool_catalog_probe",
        ],
        conversation: [
          assistantMessage(
            [toolCall({ id: "catalog", name: "tool_catalog_probe", arguments: {} })],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Capture prompt");

      catalogs.push(getToolResultMessage(result, "catalog").details);
    }

    expect(catalogs[1]).toEqual(catalogs[0]);
  });
});

import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  PiIntegrationTest,
  assistantMessage,
  getToolExecution,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";

// This observes the common Pi provider context, not the vendor-specific wire serializers.
test("Unity declarations include built-in and discovered fixture schemas", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unity-schema-"));
  try {
    const cli = path.join(root, "unity");
    await writeFile(cli, await readFile(path.join(import.meta.dirname, "schema-cli.mjs")), {
      mode: 0o755,
    });
    const project = "/projects/Fixture";
    const run = await new PiIntegrationTest({
      testName: "unity-schema-inventory",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: root,
      extensions: [
        fileURLToPath(import.meta.resolve("#unity/index.ts")),
        path.resolve(import.meta.dirname, "schema-activate.ts"),
      ],
      tools: ["unity_read", "unity_search", "unity_call", "unity_install_cli"],
      environment: { PI_UNITY_CLI: cli },
      isolateUserResources: true,
      timeoutMs: 90000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "discover",
              name: "unity_search",
              arguments: {
                path: `unity://project/${encodeURIComponent(project)}/tools`,
                query: "fixture",
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "invoke",
              name: "unity_fixture_inspect",
              arguments: { project, arguments: { path: "Scene", recursive: true, limit: 3 } },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Done")]),
      ],
    }).run("Inspect the fixture.");
    expect(getToolExecution(run, "discover").isError).toBe(false);
    expect(getToolExecution(run, "invoke").isError).toBe(false);
    const initial = getCurrentTools(run.providerRequests[0]?.messages as Message[]);
    const afterDiscovery = run.providerRequests.find((request) =>
      (request.messages as Message[]).some(
        (message) => message.role === "toolResult" && message.toolCallId === "discover",
      ),
    );
    expect(afterDiscovery).toBeDefined();
    if (!afterDiscovery) throw new Error("Missing provider request after discovery");
    const after = getCurrentTools(afterDiscovery.messages as Message[]);
    for (const name of ["unity_read", "unity_search", "unity_call", "unity_install_cli"])
      expect(initial.some((tool) => tool.name === name)).toBe(true);
    expect(initial.some((tool) => tool.name === "unity_fixture_inspect")).toBe(false);
    const tool = after.find((item) => item.name === "unity_fixture_inspect");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("Missing discovered tool");
    const schema = tool.parameters as {
      required: string[];
      properties: {
        arguments: {
          required: string[];
          properties: Record<string, unknown>;
          additionalProperties: boolean;
        };
      };
    };
    expect(schema.required).toEqual(expect.arrayContaining(["project", "arguments"]));
    expect(schema.properties.arguments.required).toContain("path");
    expect(schema.properties.arguments.properties).toMatchObject({
      path: { type: "string" },
      recursive: { type: "boolean" },
      limit: { type: "integer", minimum: 1 },
    });
    expect(schema.properties.arguments.additionalProperties).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 100000);

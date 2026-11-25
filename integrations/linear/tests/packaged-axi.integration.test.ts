import { loadCommentFixture } from "./fixtures/axi-fixture-types.ts";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import { currentIde } from "./fixtures/current-ide.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const call = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });

// Pattern: the extension example runs the real loader and tools with scripted turns.
// Contract: without axiPath, the resource provider invokes its dependency, not PATH.
test("real Pi reads through the packaged backend instead of a PATH CLI", async () => {
  const ide = await currentIde();

  const { commentCreateFixture, COMMENT_ISSUE_ID, COMMENT_WORKSPACE } = await loadCommentFixture();
  // A full issue card also reads the estimate through the fixture's GraphQL endpoint.
  const fixture = await commentCreateFixture("user", { estimate: null });
  try {
    // The fixture points axiPath at its source CLI; this test needs the installed default.
    await rm(path.join(fixture.directory, ".pi/linear.json"));
    const bin = path.join(fixture.directory, "bin");
    await mkdir(bin);
    await writeFile(
      path.join(bin, "linear-axi"),
      `#!${process.execPath}\nprocess.stderr.write("PATH CLI must not run\\n");\nprocess.exit(91);\n`,
      { mode: 0o755 },
    );
    const envFile = path.join(fixture.directory, "empty.env");
    await writeFile(envFile, "");
    const result = await new PiIntegrationTest({
      testName: "linear-packaged-backend",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: fixture.directory,
      isolateUserResources: true,
      rawMode: false,
      timeoutMs: 60000,
      extensions: [ide.extension, path.join(root, "tests/fixtures/contextual-comment-proof.ts")],
      tools: ["read", "comment_proof_control"],
      environment: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: fixture.environment.HOME,
        XDG_CONFIG_HOME: fixture.environment.XDG_CONFIG_HOME,
        CODEX_HOME: fixture.environment.CODEX_HOME,
        LINEAR_AXI_CONNECTION_FILE: fixture.environment.LINEAR_AXI_CONNECTION_FILE,
        LINEAR_AXI_MCP_URL: fixture.environment.LINEAR_AXI_MCP_URL,
        LINEAR_AXI_GRAPHQL_URL: fixture.environment.LINEAR_AXI_GRAPHQL_URL,
        LINEAR_AXI_ENV_FILE: envFile,
        PI_SESSION_ID: "synthetic-packaged-session",
        LINEAR_AXI_ROLE: "",
        LINEAR_AXI_PERSONA_CONFIG: "",
      },
      conversation: [
        call("select", "comment_proof_control", { action: "select" }),
        call("packaged-read", "read", { path: `linear://${COMMENT_WORKSPACE}/issue/ENG-12` }),
        assistantMessage([text("Finished.")]),
      ],
    }).run(
      "Select the synthetic connection and read the issue with the installed Linear provider.",
    );
    await ide.record(result.artifacts.directory);
    expect(getToolExecution(result, "select").isError, getToolResultText(result, "select")).toBe(
      false,
    );
    const output = getToolResultText(result, "packaged-read");
    expect(getToolExecution(result, "packaged-read").isError, output).toBe(false);
    expect(output).toContain("Comment fixture");
    expect(output).toContain(COMMENT_ISSUE_ID);
    expect(output).not.toContain("PATH CLI must not run");
    expect(fixture.attempts).toEqual([]);
    expect(result.tuiRenderedOutput).toContain("Comment fixture");
    expect(result.tuiRenderedOutput).not.toContain("Failed to load extension");
    expect(result.tuiRenderedOutput).not.toContain("already handles");
  } finally {
    await fixture.close();
  }
}, 90000);

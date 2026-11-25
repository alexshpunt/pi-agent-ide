import { loadCommentFixture } from "./fixtures/axi-fixture-types.ts";
import { writeFile } from "node:fs/promises";
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
import { readTextData } from "./fixtures/read-data.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const call = (id: string, name: string, args: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });

test("real Pi reads scalar fields once and enriches only requested estimates", async () => {
  const ide = await currentIde();

  const { commentCreateFixture, COMMENT_WORKSPACE } = await loadCommentFixture();
  const fixture = await commentCreateFixture("user", { resources: true, issueProjection: true });
  try {
    await writeFile(
      path.join(fixture.directory, ".pi/linear.json"),
      JSON.stringify({
        axiPath: path.join(root, "packages/linear-axi/dist/bin.js"),
      }),
    );
    const envFile = path.join(fixture.directory, "empty.env");
    await writeFile(envFile, "");
    const source = `linear://${COMMENT_WORKSPACE}/issue/ENG-12`;
    const result = await new PiIntegrationTest({
      testName: "linear-scalar-request-count",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: fixture.directory,
      isolateUserResources: true,
      rawMode: false,
      tuiSize: { cols: 110, rows: 60 },
      timeoutMs: 90000,
      extensions: [ide.extension, path.join(root, "tests/fixtures/contextual-comment-proof.ts")],
      tools: ["read", "comment_proof_control"],
      environment: {
        HOME: fixture.environment.HOME,
        XDG_CONFIG_HOME: fixture.environment.XDG_CONFIG_HOME,
        CODEX_HOME: fixture.environment.CODEX_HOME,
        LINEAR_AXI_CONNECTION_FILE: fixture.environment.LINEAR_AXI_CONNECTION_FILE,
        LINEAR_AXI_MCP_URL: fixture.environment.LINEAR_AXI_MCP_URL,
        LINEAR_AXI_GRAPHQL_URL: fixture.environment.LINEAR_AXI_GRAPHQL_URL,
        LINEAR_AXI_ENV_FILE: envFile,
        PI_SESSION_ID: "synthetic-field-budget-session",
        LINEAR_AXI_ROLE: "",
        LINEAR_AXI_PERSONA_CONFIG: "",
      },
      conversation: [
        call("select", "comment_proof_control", { action: "select" }),
        ...["status", "delegate", "estimate", "fields"].map((field) =>
          call(field, "read", { path: `${source}#${field}` }),
        ),
        assistantMessage([text("The isolated field reads completed.")]),
      ],
    }).run("Read the synthetic issue fields. Do not write or contact real Linear.");
    await ide.record(result.artifacts.directory);
    await writeFile(
      path.join(result.artifacts.directory, "request-counts.json"),
      JSON.stringify(fixture.quota, null, 2),
    );
    expect(result.exitCode).toBe(0);
    for (const id of ["select", "status", "delegate", "estimate", "fields"])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(readTextData(result, "status").content).toBe("Todo");
    expect(JSON.parse(readTextData(result, "delegate").content)).toBeNull();
    expect(JSON.parse(readTextData(result, "estimate").content)).toBe(0);
    expect(JSON.parse(readTextData(result, "fields").content)).toMatchObject({ estimate: 0 });
    expect(fixture.quota.issueInputs).toEqual([
      { id: "ENG-12", fields: ["status"] },
      { id: "ENG-12", fields: ["delegate"] },
      { id: "ENG-12", fields: ["estimate"] },
      { id: "ENG-12" },
    ]);
    expect(fixture.quota.estimateReads).toBe(2);
    expect(fixture.attempts).toEqual([]);
    expect(fixture.observed.authorizationMismatches).toBe(0);
  } finally {
    await fixture.close();
  }
}, 120000);

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

// Pattern: native-tui example and contextual-comment.integration.test.ts.
// Contract: jq receives acquired Linear JSON, not the rendered issue card.
test("real Pi applies jq to acquired Linear JSON", async () => {
  const ide = await currentIde();

  const { commentCreateFixture, COMMENT_ISSUE_ID, COMMENT_WORKSPACE } = await loadCommentFixture();
  const fixture = await commentCreateFixture("user", { estimate: null });
  try {
    await writeFile(
      path.join(fixture.directory, ".pi/linear.json"),
      JSON.stringify({ axiPath: path.join(root, "packages/linear-axi/dist/bin.js") }),
    );
    const envFile = path.join(fixture.directory, "empty.env");
    await writeFile(envFile, "");
    const result = await new PiIntegrationTest({
      testName: "linear-jq-issue",
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
        PI_SESSION_ID: "synthetic-native-jq-session",
        LINEAR_AXI_ROLE: "",
        LINEAR_AXI_PERSONA_CONFIG: "",
      },
      conversation: [
        call("select", "comment_proof_control", { action: "select" }),
        call("filtered", "read", {
          path: `linear://${COMMENT_WORKSPACE}/issue/ENG-12`,
          views: ["jq:.id"],
        }),
        call("window", "read", {
          path: `linear://${COMMENT_WORKSPACE}/issue/ENG-12`,
          views: ["jq:.id, .identifier"],
          offset: 2,
          limit: 1,
        }),
        call("empty", "read", {
          path: `linear://${COMMENT_WORKSPACE}/issue/ENG-12`,
          views: ["jq:empty"],
        }),
        call("null", "read", {
          path: `linear://${COMMENT_WORKSPACE}/issue/ENG-12`,
          views: ["jq:null"],
        }),
        call("invalid", "read", {
          path: `linear://${COMMENT_WORKSPACE}/issue/ENG-12`,
          views: ["jq:("],
        }),
        call("unsupported", "read", {
          path: `linear://${COMMENT_WORKSPACE}/issue/ENG-12/description`,
          views: ["jq:.id"],
        }),
        assistantMessage([text("The isolated JSON read completed.")]),
      ],
    }).run(
      "Select the synthetic connection and filter the acquired issue JSON. Do not write or use real Linear.",
    );
    await ide.record(result.artifacts.directory);
    await writeFile(
      path.join(result.artifacts.directory, "read-observations.json"),
      JSON.stringify({ attempts: fixture.attempts, observed: fixture.observed }, null, 2),
    );
    expect(result.exitCode).toBe(0);
    expect(getToolExecution(result, "select").isError).toBe(false);
    expect(
      getToolExecution(result, "filtered").isError,
      getToolResultText(result, "filtered"),
    ).toBe(false);
    expect(fixture.attempts).toEqual([]);
    expect(fixture.observed).toEqual({
      redirects: 0,
      readsAfterMutation: 0,
      authorizationMismatches: 0,
      tokenExchanges: 0,
    });
    const canonical = (id: string) => {
      const execution = getToolExecution(result, id);
      expect(execution.isError, getToolResultText(result, id)).toBe(false);
      return readTextData(result, id).content;
    };
    expect(JSON.parse(canonical("filtered"))).toBe(COMMENT_ISSUE_ID);
    expect(JSON.parse(canonical("window"))).toBe("ENG-12");
    expect(canonical("empty")).toBe("");
    expect(JSON.parse(canonical("null"))).toBeNull();
    expect(getToolResultText(result, "filtered")).not.toContain("Comment fixture");
    for (const id of ["invalid", "unsupported"]) {
      expect(getToolExecution(result, id).isError).toBe(true);
      expect(getToolResultText(result, id)).not.toContain("Fixture body");
    }
  } finally {
    await fixture.close();
  }
}, 120000);

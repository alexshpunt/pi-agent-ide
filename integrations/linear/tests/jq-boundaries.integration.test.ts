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

// Pattern: native-tui example and jq-views.integration.test.ts.
// Contract: typed jq reads are inspection, and an API page retains its coverage.
test("real Pi preserves JSON types and page coverage, and writes a field without a prior read", async () => {
  const ide = await currentIde();

  const { commentCreateFixture, COMMENT_ISSUE_ID, COMMENT_WORKSPACE, COMMENT_PAGE_CURSOR } =
    await loadCommentFixture();
  const fixture = await commentCreateFixture("user", { estimate: null, resources: true });
  try {
    await writeFile(
      path.join(fixture.directory, ".pi/linear.json"),
      JSON.stringify({ axiPath: path.join(root, "packages/linear-axi/dist/bin.js") }),
    );
    const envFile = path.join(fixture.directory, "empty.env");
    await writeFile(envFile, "");
    const issue = `linear://${COMMENT_WORKSPACE}/issue/ENG-12`;
    const priority = `${issue}#priority`;
    const page = `linear://${COMMENT_WORKSPACE}/issues`;
    const result = await new PiIntegrationTest({
      testName: "linear-jq-boundaries",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: fixture.directory,
      isolateUserResources: true,
      rawMode: false,
      tuiSize: { cols: 110, rows: 60 },
      timeoutMs: 90000,
      extensions: [ide.extension, path.join(root, "tests/fixtures/contextual-comment-proof.ts")],
      tools: ["read", "write", "comment_proof_control"],
      environment: {
        HOME: fixture.environment.HOME,
        XDG_CONFIG_HOME: fixture.environment.XDG_CONFIG_HOME,
        CODEX_HOME: fixture.environment.CODEX_HOME,
        LINEAR_AXI_CONNECTION_FILE: fixture.environment.LINEAR_AXI_CONNECTION_FILE,
        LINEAR_AXI_MCP_URL: fixture.environment.LINEAR_AXI_MCP_URL,
        LINEAR_AXI_GRAPHQL_URL: fixture.environment.LINEAR_AXI_GRAPHQL_URL,
        LINEAR_AXI_ENV_FILE: envFile,
        PI_SESSION_ID: "synthetic-native-jq-boundaries-session",
        LINEAR_AXI_ROLE: "",
        LINEAR_AXI_PERSONA_CONFIG: "",
      },
      conversation: [
        call("select", "comment_proof_control", { action: "select" }),
        call("identity", "read", { path: priority, views: ["jq:."] }),
        call("nonidentity", "read", { path: priority, views: ["jq:. + 0"] }),
        call("saved", "write", { path: priority, content: "2" }),
        call("after", "read", { path: priority, views: ["jq:."] }),
        call("estimate", "read", { path: `${issue}#estimate`, views: ["jq:."] }),
        call("labels", "read", { path: `${issue}#labels`, views: ["jq:."] }),
        call("page", "read", { path: page, views: ["jq:.nodes[0].id"] }),
        call("empty-page", "read", { path: page, views: ["jq:empty"] }),
        assistantMessage([text("The isolated typed reads and page checks completed.")]),
      ],
    }).run(
      "Use only the synthetic connection. Then make one acknowledged synthetic priority change without an ordinary Read and inspect the typed values and current page. Do not use real Linear or replay any write.",
    );
    await ide.record(result.artifacts.directory);
    await writeFile(
      path.join(result.artifacts.directory, "resource-observations.json"),
      JSON.stringify(
        { resources: fixture.resources, attempts: fixture.attempts, observed: fixture.observed },
        null,
        2,
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(getToolExecution(result, "select").isError).toBe(false);
    const canonical = (id: string) => {
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      return readTextData(result, id);
    };
    for (const id of ["identity", "nonidentity"]) {
      const script = canonical(id);
      expect(JSON.parse(script.content)).toBe(3);
      expect(script.target).toBeUndefined();
      expect(script.lines.flatMap((line) => line.anchors ?? [])).toEqual([]);
    }
    expect(getToolExecution(result, "saved").isError, getToolResultText(result, "saved")).toBe(
      false,
    );
    expect(JSON.parse(canonical("after").content)).toBe(2);
    expect(JSON.parse(canonical("estimate").content)).toBeNull();
    expect(JSON.parse(canonical("labels").content)).toEqual(["Bug", "Urgent"]);
    expect(JSON.parse(canonical("page").content)).toBe(COMMENT_ISSUE_ID);
    expect(canonical("empty-page").content).toBe("");
    for (const id of ["page", "empty-page"])
      expect(getToolResultText(result, id)).toContain(`cursor=${COMMENT_PAGE_CURSOR}`);
    expect(result.tuiRenderedOutput.replaceAll(/\s/gu, "")).toContain(
      `cursor=${COMMENT_PAGE_CURSOR}`,
    );
    expect(fixture.resources).toBeDefined();
    expect(fixture.resources?.mutations).toEqual([{ id: COMMENT_ISSUE_ID, priority: 2 }]);
    expect(fixture.resources?.pageInputs).toEqual([{ limit: 50 }, { limit: 50 }]);
    expect(fixture.attempts).toEqual([]);
    expect(fixture.observed).toEqual({
      redirects: 0,
      readsAfterMutation: 0,
      authorizationMismatches: 0,
      tokenExchanges: 0,
    });
    for (const value of [
      JSON.stringify(result.messages),
      result.terminalOutput,
      result.tuiRenderedOutput,
    ])
      expect(value).not.toContain("synthetic-comment-key");
  } finally {
    await fixture.close();
  }
}, 120000);

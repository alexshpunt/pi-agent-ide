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

// Pattern: jq-views and read-error-guidance integrations; only the external service is synthetic.
test("real Pi reports unsupported issue milestones without treating them as text anchors", async () => {
  const ide = await currentIde();
  const { commentCreateFixture, COMMENT_WORKSPACE } = await loadCommentFixture();
  const fixture = await commentCreateFixture("user", { estimate: null, resources: true });
  try {
    await writeFile(
      path.join(fixture.directory, ".pi/linear.json"),
      JSON.stringify({
        axiPath: path.join(root, "packages/linear-axi/dist/bin.js"),
      }),
    );
    const envFile = path.join(fixture.directory, "empty.env");
    await writeFile(envFile, "");
    const source = `linear://${COMMENT_WORKSPACE}/issue/ENG-12#milestone`;
    const result = await new PiIntegrationTest({
      testName: "issue-milestone-unsupported",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: fixture.directory,
      isolateUserResources: true,
      rawMode: false,
      tuiSize: { cols: 110, rows: 60 },
      timeoutMs: 90000,
      extensions: [
        ide.extension,
        "builtin:codemode",
        path.join(root, "tests/fixtures/contextual-comment-proof.ts"),
      ],
      tools: ["read", "codemode", "comment_proof_control"],
      environment: {
        HOME: fixture.environment.HOME,
        XDG_CONFIG_HOME: fixture.environment.XDG_CONFIG_HOME,
        CODEX_HOME: fixture.environment.CODEX_HOME,
        LINEAR_AXI_CONNECTION_FILE: fixture.environment.LINEAR_AXI_CONNECTION_FILE,
        LINEAR_AXI_MCP_URL: fixture.environment.LINEAR_AXI_MCP_URL,
        LINEAR_AXI_GRAPHQL_URL: fixture.environment.LINEAR_AXI_GRAPHQL_URL,
        LINEAR_AXI_ENV_FILE: envFile,
        PI_SESSION_ID: "synthetic-issue-milestone-session",
        LINEAR_AXI_ROLE: "",
        LINEAR_AXI_PERSONA_CONFIG: "",
      },
      conversation: [
        call("select", "comment_proof_control", { action: "select" }),
        call("direct", "read", { path: source }),
        call("nested", "codemode", {
          code: `const value = await tools.read({path:${JSON.stringify(source)}}); if (value !== null) throw new Error("Expected null for failed Read"); text("continued after failed Read");`,
        }),
        assistantMessage([text("The field failures were observed without retrying them.")]),
      ],
    }).run(
      "Read the synthetic issue milestone directly and through Codemode. Do not mutate or use real Linear.",
    );
    await ide.record(result.artifacts.directory);
    await writeFile(
      path.join(result.artifacts.directory, "resource-observations.json"),
      JSON.stringify(
        {
          resources: fixture.resources,
          attempts: fixture.attempts,
          observed: fixture.observed,
        },
        null,
        2,
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(getToolExecution(result, "select").isError).toBe(false);
    expect(getToolExecution(result, "direct").isError).toBe(true);
    expect(getToolExecution(result, "nested").isError).toBe(false);
    for (const id of ["direct", "nested"])
      expect(getToolResultText(result, id)).toContain("LINEAR_FIELD_UNSUPPORTED");
    expect(getToolResultText(result, "nested")).toContain("continued after failed Read");
    expect(fixture.resources?.mutations).toEqual([]);
    expect(fixture.resources?.pageInputs).toEqual([]);
    expect(fixture.attempts).toEqual([]);
    expect(fixture.observed).toEqual({
      redirects: 0,
      readsAfterMutation: 0,
      authorizationMismatches: 0,
      tokenExchanges: 0,
    });
  } finally {
    await fixture.close();
  }
}, 120000);

test("real Pi reads typed milestones and distinguishes unavailable data from unset values", async () => {
  const ide = await currentIde();
  const { commentCreateFixture, COMMENT_WORKSPACE, PRIVATE_COMMENT_ERROR } =
    await loadCommentFixture();
  const milestone = { id: "42908f54-91f9-4a46-8181-81fc1c3c8ee4", name: "Release α" };
  const fixture = await commentCreateFixture("user", {
    estimate: null,
    resources: true,
    milestoneField: true,
    issueResponses: {
      "ENG-101": { identifier: "ENG-101", projectMilestone: milestone },
      "ENG-102": { identifier: "ENG-102", projectMilestone: null },
      "ENG-103": { identifier: "ENG-103", description: "milestone milestone" },
      "ENG-104": { identifier: "ENG-104", milestone: false },
      "ENG-105": null,
      "ENG-106": { identifier: "ENG-106", milestone },
      "ENG-107": { identifier: "ENG-107", projectMilestone: milestone },
    },
  });
  try {
    await writeFile(
      path.join(fixture.directory, ".pi/linear.json"),
      JSON.stringify({
        axiPath: path.join(root, "packages/linear-axi/dist/bin.js"),
      }),
    );
    const envFile = path.join(fixture.directory, "empty.env");
    await writeFile(envFile, "");
    const issue = (id: number) => `linear://${COMMENT_WORKSPACE}/issue/ENG-${id}`;
    const field = (id: number) => `${issue(id)}#milestone`;
    const result = await new PiIntegrationTest({
      testName: "issue-milestone-values",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd: fixture.directory,
      isolateUserResources: true,
      rawMode: false,
      tuiSize: { cols: 110, rows: 60 },
      timeoutMs: 90000,
      extensions: [
        ide.extension,
        "builtin:codemode",
        path.join(root, "tests/fixtures/contextual-comment-proof.ts"),
      ],
      tools: ["read", "write", "codemode", "comment_proof_control"],
      environment: {
        HOME: fixture.environment.HOME,
        XDG_CONFIG_HOME: fixture.environment.XDG_CONFIG_HOME,
        CODEX_HOME: fixture.environment.CODEX_HOME,
        LINEAR_AXI_CONNECTION_FILE: fixture.environment.LINEAR_AXI_CONNECTION_FILE,
        LINEAR_AXI_MCP_URL: fixture.environment.LINEAR_AXI_MCP_URL,
        LINEAR_AXI_GRAPHQL_URL: fixture.environment.LINEAR_AXI_GRAPHQL_URL,
        LINEAR_AXI_ENV_FILE: envFile,
        PI_SESSION_ID: "synthetic-issue-milestone-values-session",
        LINEAR_AXI_ROLE: "",
        LINEAR_AXI_PERSONA_CONFIG: "",
      },
      conversation: [
        call("select", "comment_proof_control", { action: "select" }),
        call("assigned", "read", { path: field(101) }),
        call("native", "read", {
          path: `https://linear.app/${COMMENT_WORKSPACE}/issue/ENG-101/fixture#milestone`,
        }),
        call("mcp", "read", { path: field(106) }),
        call("unset", "read", { path: field(102) }),
        call("jq-assigned", "read", { path: field(101), views: ["jq:.id"] }),
        call("jq-unset", "read", { path: field(102), views: ["jq:."] }),
        call("missing", "read", { path: field(103) }),
        call("malformed", "read", { path: field(104) }),
        call("backend", "read", { path: field(105) }),
        call("nested-assigned", "codemode", {
          code: `const value = await tools.read({path:${JSON.stringify(field(101))},views:["jq:.id"]}); if (!value || JSON.parse(value.text) !== ${JSON.stringify(milestone.id)} || !/^RESULT#/.test(value.id)) throw new Error("Invalid Read value"); text(value.text);`,
        }),
        call("nested-missing", "codemode", {
          code: `const value = await tools.read({path:${JSON.stringify(field(103))}}); if (value !== null) throw new Error("Expected null for failed Read"); text("continued after missing field");`,
        }),
        call("body-anchor", "read", { path: `${issue(12)}/description#Fixture` }),
        call("derived", "read", { path: field(107), views: ["jq:."] }),
        assistantMessage([text("Typed milestone reads completed without mutating the service.")]),
      ],
    }).run("Inspect synthetic milestone values and failures. Do not use real Linear.");
    await ide.record(result.artifacts.directory);
    await writeFile(
      path.join(result.artifacts.directory, "resource-observations.json"),
      JSON.stringify(
        {
          resources: fixture.resources,
          attempts: fixture.attempts,
          observed: fixture.observed,
        },
        null,
        2,
      ),
    );
    expect(result.exitCode).toBe(0);
    const canonical = (id: string) => {
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
      return readTextData(result, id);
    };
    for (const id of ["assigned", "native", "mcp"])
      expect(JSON.parse(canonical(id).content)).toEqual(milestone);
    for (const id of ["unset", "jq-unset"]) expect(JSON.parse(canonical(id).content)).toBeNull();
    expect(JSON.parse(canonical("jq-assigned").content)).toBe(milestone.id);
    expect(getToolExecution(result, "nested-assigned").isError).toBe(false);
    expect(getToolResultText(result, "nested-assigned")).toContain(milestone.id);
    for (const [id, code] of [
      ["missing", "LINEAR_FIELD_NOT_EXPOSED"],
      ["malformed", "LINEAR_INVALID_RESPONSE"],
      ["backend", "LINEAR_OPERATION_BACKEND_REJECTED"],
    ]) {
      expect(getToolExecution(result, id).isError).toBe(true);
      expect(getToolResultText(result, id)).toContain(code);
    }
    expect(getToolExecution(result, "nested-missing").isError).toBe(false);
    expect(getToolResultText(result, "nested-missing")).toContain("LINEAR_FIELD_NOT_EXPOSED");
    expect(getToolResultText(result, "nested-missing")).toContain("continued after missing field");
    expect(canonical("body-anchor").content).toContain("Fixture body");
    expect(JSON.parse(canonical("derived").content)).toEqual(milestone);
    expect(canonical("derived").target).toBeUndefined();
    expect(fixture.resources?.mutations).toEqual([]);
    expect(fixture.resources?.pageInputs).toEqual([]);
    expect(fixture.attempts).toEqual([]);
    expect(fixture.observed).toEqual({
      redirects: 0,
      readsAfterMutation: 0,
      authorizationMismatches: 0,
      tokenExchanges: 0,
    });
    for (const output of [
      JSON.stringify(result.messages),
      result.terminalOutput,
      result.tuiRenderedOutput,
    ]) {
      expect(output).not.toContain(PRIVATE_COMMENT_ERROR);
      expect(output).not.toContain("synthetic-comment-key");
    }
  } finally {
    await fixture.close();
  }
}, 120000);

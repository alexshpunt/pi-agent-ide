import { loadCommentFixture } from "./fixtures/axi-fixture-types.ts";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
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

// Pattern: native-tui example and request-cooldown.integration.test.ts.
// Contract: production session selection, Write, CLI and protocol server agree on author and effects.
test.each(["user", "installed-app", "app-success", "app-rejected", "app-rate-limited"] as const)(
  "real Pi preserves contextual comment authors and effects (%s)",
  async (scenario) => {
    const ide = await currentIde();

    const { commentCreateFixture, COMMENT_ID, COMMENT_WORKSPACE, PRIVATE_COMMENT_ERROR } =
      await loadCommentFixture();
    const actor = scenario === "user" ? "user" : "app";
    const fixture = await commentCreateFixture(actor, {
      outcome: (
        {
          user: "success",
          "installed-app": "success",
          "app-success": "partial-success",
          "app-rejected": "forbidden",
          "app-rate-limited": "http-429",
        } as const
      )[scenario],
      unavailableReadback: scenario === "app-success",
    });
    try {
      await writeFile(
        path.join(fixture.directory, ".pi/linear.json"),
        JSON.stringify({ axiPath: path.join(root, "packages/linear-axi/src/bin.ts") }),
      );
      const envFile = path.join(fixture.directory, "empty.env");
      await writeFile(envFile, "");
      const source = `linear://${COMMENT_WORKSPACE}/issue/ENG-12/comments/new`;
      const created = `linear://${COMMENT_WORKSPACE}/issue/ENG-12/comment/${COMMENT_ID}`;
      const result = await new PiIntegrationTest({
        testName: `linear-contextual-comment-${scenario}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd: fixture.directory,
        isolateUserResources: true,
        rawMode: false,
        tuiSize: { cols: 110, rows: 60 },
        timeoutMs: 90000,
        extensions: [ide.extension, path.join(root, "tests/fixtures/contextual-comment-proof.ts")],
        tools: ["write", "comment_proof_control"],
        environment: {
          HOME: fixture.environment.HOME,
          XDG_CONFIG_HOME: fixture.environment.XDG_CONFIG_HOME,
          CODEX_HOME: fixture.environment.CODEX_HOME,
          LINEAR_AXI_CONNECTION_FILE: fixture.environment.LINEAR_AXI_CONNECTION_FILE,
          LINEAR_AXI_MCP_URL: fixture.environment.LINEAR_AXI_MCP_URL,
          LINEAR_AXI_GRAPHQL_URL: fixture.environment.LINEAR_AXI_GRAPHQL_URL,
          LINEAR_AXI_TOKEN_FILE: fixture.environment.LINEAR_AXI_TOKEN_FILE,
          LINEAR_AXI_ENV_FILE: envFile,
          PI_SESSION_ID: "synthetic-native-comment-session",
          PI_AGENT_ROLE: "",
          PI_SUBAGENT_AGENT: "",
          LINEAR_AXI_ROLE: "qa",
          LINEAR_AXI_PERSONA_CONFIG: path.join(fixture.directory, "unreadable-personas.json"),
        },
        conversation: [
          call("select", "comment_proof_control", {
            action: scenario === "installed-app" ? "connect-app" : "select",
          }),
          call("created", "write", { path: source, content: "Native comment proof." }),
          ...(scenario === "user"
            ? [
                call("persona", "comment_proof_control", { action: "require-persona" }),
                call("authored-as-user", "write", {
                  path: source,
                  content: "User identity overrides the app persona.",
                }),
              ]
            : []),
          assistantMessage([text("The isolated comment proof completed.")]),
        ],
      }).run(
        "Select the saved synthetic connection and exercise the scripted contextual comment outcome. Do not use real Linear or replay a failed mutation.",
      );
      await ide.record(result.artifacts.directory);
      await writeFile(
        path.join(result.artifacts.directory, "comment-attempts.json"),
        JSON.stringify(fixture.attempts, null, 2),
      );
      expect(result.exitCode).toBe(0);
      expect(getToolExecution(result, "select").isError).toBe(false);
      const selected = JSON.parse(getToolResultText(result, "select")) as {
        selection: { connectionId: string };
      };
      const selectedId = selected.selection.connectionId;
      if (scenario === "installed-app") {
        expect(selectedId).toMatch(/^[a-f0-9-]{36}$/u);
        expect(selectedId).not.toBe(fixture.environment.LINEAR_AXI_CONNECTION_ID);
      } else expect(selectedId).toBe(fixture.environment.LINEAR_AXI_CONNECTION_ID);
      if (scenario === "app-rejected" || scenario === "app-rate-limited") {
        const code =
          scenario === "app-rejected"
            ? "LINEAR_OPERATION_PERMISSION_DENIED"
            : "LINEAR_OPERATION_RATE_LIMITED";
        expect(getToolExecution(result, "created").isError).toBe(true);
        expect(getToolExecutionDetails(getToolExecution(result, "created"))).toMatchObject({
          effect: "unknown",
          results: [
            {
              data: {
                errors: [
                  {
                    code,
                    ...(scenario === "app-rate-limited"
                      ? { metadata: { rateLimit: { retryAfterMs: 37000 } } }
                      : {}),
                  },
                ],
              },
            },
          ],
        });
        expect(getToolResultText(result, "created")).toContain(code);
      } else {
        expect(
          getToolExecution(result, "created").isError,
          getToolResultText(result, "created"),
        ).toBe(false);
        expect(getToolExecutionDetails(getToolExecution(result, "created"))).toMatchObject({
          metadata: { semanticAction: { effect: "applied", id: COMMENT_ID, source: created } },
        });
        expect(getToolResultText(result, "created")).toContain(created);
        expect(result.tuiRenderedOutput.replaceAll(/\s/gu, "")).toContain(COMMENT_ID);
      }
      if (scenario === "user") {
        expect(
          getToolExecution(result, "authored-as-user").isError,
          getToolResultText(result, "authored-as-user"),
        ).toBe(false);
        expect(getToolExecutionDetails(getToolExecution(result, "authored-as-user"))).toMatchObject(
          {
            metadata: { semanticAction: { effect: "applied", id: COMMENT_ID, source: created } },
          },
        );
        expect(fixture.attempts).toEqual([
          { transport: "mcp", input: { issueId: "ENG-12", body: "Native comment proof." } },
          {
            transport: "mcp",
            input: { issueId: "ENG-12", body: "User identity overrides the app persona." },
          },
        ]);
      } else {
        expect(fixture.attempts).toHaveLength(1);
        expect(fixture.attempts[0]).toMatchObject({
          transport: "mcp",
          input: { issueId: "ENG-12", body: "Native comment proof." },
        });
        expect(fixture.observed.tokenExchanges).toBe(1);
        if (scenario === "app-success") expect(fixture.observed.readsAfterMutation).toBe(0);
      }
      expect(fixture.observed.redirects).toBe(0);
      expect(fixture.observed.authorizationMismatches).toBe(0);
      for (const value of [
        JSON.stringify(result.messages),
        result.terminalOutput,
        result.tuiRenderedOutput,
      ]) {
        expect(value).not.toContain(PRIVATE_COMMENT_ERROR);
        expect(value).not.toContain("synthetic-comment-key");
      }
    } finally {
      await fixture.close();
    }
  },
  120000,
);

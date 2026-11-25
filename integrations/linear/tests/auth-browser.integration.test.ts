import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { browserLauncherEnvironment } from "./fixtures/browser-launcher.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
// Pattern: native-tui.integration.test.ts and the account replacement case.
// Contract: the user can see the real authorize link while login is pending, without adding it to model history.
test("real Pi shows the pending OAuth link to the user and keeps it out of model messages", async () => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/auth-browser-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(
      path.join(cwd, ".pi/linear.json"),
      JSON.stringify({ axiPath: path.join(root, "tests/fixtures/auth-cli.mjs") }),
    );
    const run = await new PiIntegrationTest({
      testName: "linear-browser-auth-link",
      environment: await browserLauncherEnvironment(cwd),
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      timeoutMs: 45_000,
      extensions: [path.join(root, "tests/fixtures/auth-account.ts")],
      tools: ["auth_account_fixture"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "logout",
              name: "auth_account_fixture",
              arguments: { action: "logout" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [toolCall({ id: "login", name: "auth_account_fixture", arguments: { action: "login" } })],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Finished synthetic browser-flow checks.")]),
      ],
    }).run(
      "Use only the synthetic account fixture. Do not open any real browser or authorize a real account.",
    );
    for (const id of ["logout", "login"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(run.terminalOutput).toContain("https://mcp.linear.app/authorize");
    expect(run.terminalOutput).toContain("Login to Linear");
    expect(run.terminalOutput).toContain("Waiting for authorization in your browser");
    expect(run.terminalOutput).toContain("to copy");
    expect(run.tuiRenderedOutput).toContain("OAuth account");
    expect(run.tuiRenderedOutput).toContain("Granted scopes: read");
    expect(JSON.stringify(run.messages)).not.toContain("synthetic-state");
    expect(JSON.stringify(run.messages)).not.toContain("https://mcp.linear.app/authorize");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);

test("Escape cancels Pi's Linear login dialog without saving the pending credential", async () => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/auth-cancel-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(
      path.join(cwd, ".pi/linear.json"),
      JSON.stringify({ axiPath: path.join(root, "tests/fixtures/auth-cli.mjs") }),
    );
    await writeFile(
      path.join(cwd, "auth-fixture-state.json"),
      JSON.stringify({ state: "signed-out", epoch: "before" }),
    );
    const run = await new PiIntegrationTest({
      testName: "linear-browser-auth-cancel",
      environment: await browserLauncherEnvironment(cwd),
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      timeoutMs: 45_000,
      extensions: [path.join(root, "tests/fixtures/auth-account.ts")],
      tools: ["auth_account_fixture"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "cancel",
              name: "auth_account_fixture",
              arguments: { action: "login-cancel" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Finished cancellation check.")]),
      ],
    }).run("Use only the isolated synthetic login fixture.");
    expect(getToolExecution(run, "cancel").isError, getToolResultText(run, "cancel")).toBe(false);
    expect(run.terminalOutput).toContain("Login to Linear");
    expect(run.terminalOutput).toContain("sign-in was cancelled");
    expect(JSON.parse(await readFile(path.join(cwd, "auth-fixture-state.json"), "utf8"))).toEqual({
      state: "signed-out",
      epoch: "before",
    });
    expect(JSON.stringify(run.messages)).not.toContain("synthetic-state");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);
test("cancelling the real revoke loader reports unknown after local retirement", async () => {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/auth-revoke-ui-"));
  try {
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(
      path.join(cwd, ".pi/linear.json"),
      JSON.stringify({ axiPath: path.join(root, "tests/fixtures/auth-cli.mjs") }),
    );
    await writeFile(
      path.join(cwd, "auth-fixture-state.json"),
      JSON.stringify({
        state: "connected",
        epoch: "confirmed-a",
        credentialType: "oauth",
        actor: "user",
        identity: {
          id: "user-a",
          name: "Account A",
          workspace: { id: "workspace-1", slug: "example", name: "Example" },
        },
        capabilities: { mcp: true, native: true, storage: true, refresh: false, revoke: true },
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "linear-revoke-loader-cancel",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      rawMode: false,
      timeoutMs: 45_000,
      extensions: [path.join(root, "tests/fixtures/auth-account.ts")],
      tools: ["auth_account_fixture"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "revoke",
              name: "auth_account_fixture",
              arguments: { action: "revoke" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Finished synthetic revoke cancellation.")]),
      ],
    }).run("Use only the isolated revoke fixture. Never authorize or revoke a real grant.");
    expect(getToolExecution(run, "revoke").isError, getToolResultText(run, "revoke")).toBe(false);
    expect(run.tuiRenderedOutput).toContain("may have revoked this grant");
    expect(run.tuiRenderedOutput).toContain("LINEAR_AUTH_REVOKE_UNKNOWN");
    expect(run.tuiRenderedOutput).not.toContain("Linear sign-in was cancelled");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 60_000);

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
const document = "linear://example/document/71000000-0000-4000-8000-000000000006/content";
async function workspace() {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp/named-auth-"));
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(
    path.join(cwd, ".pi/linear.json"),
    JSON.stringify({ axiPath: path.join(root, "tests/fixtures/named-auth-cli.mjs") }),
  );
  return cwd;
}
const account = (id: string, action: string) =>
  assistantMessage([toolCall({ id, name: "named_auth_fixture", arguments: { action } })], {
    stopReason: "toolUse",
  });
async function run(
  cwd: string,
  testName: string,
  conversation: ReturnType<typeof assistantMessage>[],
) {
  return new PiIntegrationTest({
    testName,
    artifactsDir: testArtifactsDir(import.meta.filename),
    cwd,
    isolateUserResources: true,
    rawMode: false,
    timeoutMs: 90_000,
    extensions: ["builtin:tool-search", path.join(root, "tests/fixtures/named-auth-ui.ts")],
    tools: ["tool_search", "named_auth_fixture"],
    environment: await browserLauncherEnvironment(cwd),
    conversation: [
      ...conversation,
      assistantMessage([text("Synthetic saved-connection checks completed.")]),
    ],
  }).run(
    "Exercise only the isolated synthetic Linear store. Never access real credentials or authorize a real account.",
  );
}

// Pattern: auth-account.integration.test.ts and the package extension example.
// Contract: production Pi loader/UI/process/backend select named keys without logout and persist only profile IDs.
test("real Pi switches named keys without logout and new chats use the explicit default", async () => {
  const cwd = await workspace();
  try {
    const result = await run(cwd, "linear-named-connections", [
      assistantMessage(
        [
          toolCall({
            id: "discover",
            name: "tool_search",
            arguments: { query: "linear read", limit: 10 },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      account("add-work", "add-work"),
      account("add-personal", "add-personal"),
      account("list-two", "list"),
      account("switch-work", "switch-work"),
      account("default-work", "default-work"),
      assistantMessage(
        [toolCall({ id: "read-work", name: "linear_read", arguments: { path: document } })],
        { stopReason: "toolUse" },
      ),
      account("switch-personal", "switch-personal"),
      assistantMessage(
        [toolCall({ id: "read-personal", name: "linear_read", arguments: { path: document } })],
        { stopReason: "toolUse" },
      ),
      account("switch-back", "switch-work"),
      account("remove-personal", "remove-personal"),
      account("status-work", "status"),
    ]);
    for (const id of [
      "discover",
      "add-work",
      "add-personal",
      "switch-work",
      "default-work",
      "read-work",
      "read-personal",
      "remove-personal",
      "switch-back",
      "status-work",
    ])
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(getToolResultText(result, "read-work")).toContain("Work user document");
    expect(getToolResultText(result, "read-personal")).toContain("Personal user document");
    const selection = (run: typeof result, id: string) => {
      const data = JSON.parse(getToolResultText(run, id)) as {
        selection: { connectionId: string };
      };
      return data.selection.connectionId;
    };
    expect(selection(result, "add-work")).not.toBe(selection(result, "add-personal"));
    expect(selection(result, "switch-work")).toBe(selection(result, "add-work"));
    expect(selection(result, "remove-personal")).toBe(selection(result, "add-work"));
    expect(selection(result, "switch-back")).toBe(selection(result, "add-work"));
    expect(result.tuiRenderedOutput).toContain("Work");
    expect(result.tuiRenderedOutput).toContain("saved");
    expect(result.terminalOutput).toContain("input stays private");
    for (const secret of ["synthetic-work-key", "synthetic-personal-key"]) {
      expect(result.terminalOutput).not.toContain(secret);
      expect(JSON.stringify(result.messages)).not.toContain(secret);
    }
    const fresh = await run(cwd, "linear-named-default-new-chat", [
      account("initial-selection", "selection"),
      account("status-default", "status"),
    ]);
    expect(selection(fresh, "initial-selection")).toBe(selection(result, "add-work"));
    expect(fresh.tuiRenderedOutput).toContain("Work user");
    expect(fresh.tuiRenderedOutput).not.toContain("Personal user");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);

test("real Pi opens the browser sign-in URL through a launcher while keeping it out of model history", async () => {
  const cwd = await workspace();
  try {
    const result = await run(cwd, "linear-named-browser-open", [
      account("browser", "browser"),
      account("status-browser", "status"),
    ]);
    const [url] = JSON.parse(
      await readFile(path.join(cwd, "browser-opened.json"), "utf8"),
    ) as string[];
    expect(new URL(url).origin).toBe("https://linear.app");
    expect(new URL(url).pathname).toBe("/oauth/authorize");
    expect(result.terminalOutput).toContain("Login to Linear");
    expect(result.terminalOutput).toContain("Waiting for authorization in your browser");
    expect(result.tuiRenderedOutput).toContain("Browser user");
    expect(result.tuiRenderedOutput).toContain("Own-app user OAuth");
    expect(JSON.stringify(result.messages)).not.toContain("https://linear.app/oauth/authorize");
    expect(JSON.stringify(result.messages)).not.toContain("synthetic-browser-key");
    expect(getToolResultText(result, "browser")).toContain("connectionId");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);

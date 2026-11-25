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
import { currentIde } from "./fixtures/current-ide.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const body = "linear://example/document/71000000-0000-4000-8000-000000000006/content";
// Pattern: the extension example and standalone.integration.test.ts. Contract: real loader, account UI,
// private stdin import and identity replacement invalidate actual standalone editing authority.
test.each(["standalone", "ide-first", "linear-first"])(
  "real Pi account replacement keeps old authority invalid and secrets private (%s)",
  async (mode) => {
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/auth-account-"));
    try {
      await mkdir(path.join(cwd, ".pi"));
      await writeFile(
        path.join(cwd, ".pi/linear.json"),
        JSON.stringify({ axiPath: path.join(root, "tests/fixtures/auth-cli.mjs") }),
      );
      const selector = mode === "standalone" ? "start" : "at";
      const tool = (name: string) => (mode === "standalone" ? `linear_${name}` : name);
      const { extension: ide } = await currentIde();
      const fixture = path.join(root, "tests/fixtures/auth-account.ts");
      const calls: [string, string, Record<string, unknown>][] = [
        ["discover", "tool_search", { query: "linear read replace", limit: 10 }],
        ["status-a", "auth_account_fixture", { action: "status" }],
        ["read-a", tool("read"), { path: body }],
        ["logout", "auth_account_fixture", { action: "logout" }],
        ["disconnected", tool("read"), { path: body }],
        ["connect-b", "auth_account_fixture", { action: "connect-b" }],
        [
          "stale-a",
          tool("replace"),
          { path: body, [selector]: "Full document", text: "Not allowed from A" },
        ],
        ["search-b", tool("search"), { path: body, query: "Full" }],
        [
          "outside-b",
          tool("replace"),
          { path: body, [selector]: "Last line", text: "Outside the returned match" },
        ],
        ["search-b-fresh", tool("search"), { path: body, query: "Full" }],
        ["match-b", tool("replace"), { path: body, [selector]: "Full", text: "Real" }],
        ["read-b", tool("read"), { path: body }],
        [
          "write-b",
          tool("replace"),
          { path: body, [selector]: "Real document", text: "Updated by B" },
        ],
        ["verify-b", tool("read"), { path: body }],
      ];
      const run = await new PiIntegrationTest({
        testName: `linear-account-replacement-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        timeoutMs: 90_000,
        extensions: [
          "builtin:tool-search",
          ...(mode === "standalone"
            ? [fixture]
            : mode === "ide-first"
              ? [ide, fixture]
              : [fixture, ide]),
        ],
        tools: [
          "tool_search",
          "auth_account_fixture",
          ...(mode === "standalone" ? [] : ["read", "search", "replace"]),
        ],
        conversation: [
          ...calls.map(([id, name, args]) =>
            assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
          ),
          assistantMessage([text("Finished isolated account checks.")]),
        ],
      }).run(
        "Use only the synthetic account fixture. Never access real credential files or a real Linear workspace.",
      );
      for (const [id] of calls.filter(
        ([id]) => !["stale-a", "outside-b", "disconnected"].includes(id),
      ))
        expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      expect(getToolExecution(run, "disconnected").isError).toBe(true);
      expect(getToolExecution(run, "stale-a").isError).toBe(true);
      expect(getToolExecution(run, "outside-b").isError).toBe(true);
      expect(getToolResultText(run, "verify-b")).toContain("Updated by B");
      expect(getToolResultText(run, "read-b")).toContain("Real document");
      expect(
        JSON.parse(await readFile(path.join(cwd, "auth-fixture-state.json"), "utf8")),
      ).toMatchObject({ epoch: "account-b", identity: { id: "user-b" } });
      // These notifications precede later document edits and scroll out of the final screen.
      // Assert their actual terminal record, and keep a separate final-frame assertion.
      expect(run.terminalOutput).toContain("Account A");
      expect(run.terminalOutput).toContain("forgotten locally");
      expect(run.tuiRenderedOutput).toContain("Updated by B");
      expect(run.terminalOutput).toContain("input stays private");
      expect(run.terminalOutput).toContain("••••");
      expect(run.terminalOutput).not.toContain("synthetic-key-never-logged");
      expect(JSON.stringify(run.messages)).not.toContain("synthetic-key-never-logged");
      expect(run.tuiRenderedOutput).not.toContain("Failed to load extension");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120_000,
);

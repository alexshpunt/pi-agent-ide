import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
import { githubPackageRoot } from "./fixtures/package-root.ts";

const root = githubPackageRoot;
const fixture = path.join(root, "tests/fixtures/github-login-provider.ts");

test.each(["switch", "global", "logout"] as const)(
  "real Pi manages the selected connection without a footer (%s)",
  async (scenario) => {
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/github-menu-"));
    try {
      const result = await new PiIntegrationTest({
        testName: `github-connection-${scenario}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        tuiSize: { cols: 80, rows: 24 },
        extensions: [fixture],
        tools: ["github_login_fixture"],
        timeoutMs: 45_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "menu",
                name: "github_login_fixture",
                arguments: { cancel: false, scenario },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Finished.")]),
        ],
      }).run("Use the isolated synthetic GitHub connection menu.");
      expect(getToolExecution(result, "menu").isError, getToolResultText(result, "menu")).toBe(
        false,
      );
      const actual: unknown = JSON.parse(getToolResultText(result, "menu"));
      expect(actual).toEqual(
        scenario === "switch"
          ? {
              menuSizes: [3, 2, 2, 3],
              current: "b",
              projectDefault: "a",
              profiles: ["a", "b"],
              credentialIds: ["a", "b"],
              footerWrites: 0,
            }
          : scenario === "global"
            ? {
                menuSizes: [3, 2, 2, 3],
                current: "a",
                projectDefault: "a",
                profiles: ["a", "b"],
                credentialIds: ["a", "b"],
                footerWrites: 0,
                globalDefault: "b",
                newSession: "b",
              }
            : {
                menuSizes: [3, 2, 3],
                current: "a",
                projectDefault: "a",
                profiles: ["a"],
                credentialIds: ["a"],
                footerWrites: 0,
              },
      );
      expect(result.terminalOutput).toContain("fixture-account-b");
      expect(result.terminalOutput).not.toContain("fixture-private-");
      expect(
        JSON.stringify([result.messages, result.providerRequests, result.state]),
      ).not.toContain("fixture-private-");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  60_000,
);

// Exercise the production command and real native device dialog with a fully offline transport.
test.each([false, true])(
  "real Pi GitHub device login keeps codes private (cancel=%s)",
  async (cancel) => {
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/github-login-"));
    try {
      const result = await new PiIntegrationTest({
        testName: cancel ? "github-device-cancel" : "github-device-login",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        // The fixture opens its store before session_start, so give it a fresh Pi process and cwd.
        tuiSize: { cols: 80, rows: 24 },
        extensions: [fixture],
        tools: ["github_login_fixture"],
        timeoutMs: 45_000,
        conversation: [
          assistantMessage(
            [toolCall({ id: "login", name: "github_login_fixture", arguments: { cancel } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Synthetic sign-in finished.")]),
        ],
      }).run("Use only the isolated synthetic GitHub login fixture.");
      expect(getToolExecution(result, "login").isError, getToolResultText(result, "login")).toBe(
        false,
      );
      expect(result.terminalOutput).toContain("PIAA-TEST");
      expect(result.terminalOutput).toContain("https://github.com/login/device");
      for (const sensitive of [
        "PIAA-TEST",
        "https://github.com/login/device",
        "fixture-private-device",
        "fixture-private-access",
        "fixture-private-refresh",
      ]) {
        expect(
          JSON.stringify([result.messages, result.providerRequests, result.state]),
        ).not.toContain(sensitive);
      }
      for (const secret of [
        "fixture-private-device",
        "fixture-private-access",
        "fixture-private-refresh",
      ]) {
        expect(result.terminalOutput).not.toContain(secret);
      }
      const files = await readFile(path.join(cwd, ".connections", "profiles.json"), "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "{}";
          throw error;
        },
      );
      const profiles = JSON.parse(files) as {
        profiles?: { kind: string; label: string; login?: string }[];
      };
      if (cancel) expect(profiles.profiles ?? []).toEqual([]);
      else
        expect(profiles.profiles).toEqual([
          expect.objectContaining({
            kind: "device",
            label: "Synthetic account",
            login: "fixture-user",
          }),
        ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  60_000,
);

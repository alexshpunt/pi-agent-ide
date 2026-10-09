import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { createChangeGroups } from "pi-agent-ide-changes/changes/change-groups";
import { requiredValue } from "pi-agent-invariant";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

const runFile = promisify(execFile);
const fileName = "tracked.txt";
const baseline = "alpha\nbeta\ngamma\n";
const current = "alpha\nBETA\ngamma\n";
const selector = requiredValue(
  createChangeGroups(fileName, baseline, baseline, current)[0],
).selector;

test.each(["applied", "already-staged", "stale"] as const)(
  "Stage %s hides internal metadata only from the full IDE's native display",
  async (state) => {
    await withTempWorkspace(async (cwd) => {
      const git = (args: string[]) => runFile("git", args, { cwd });
      const file = path.join(cwd, fileName);
      await git(["init", "--quiet", "--initial-branch=main"]);
      await writeFile(file, baseline);
      await git(["add", fileName]);
      await git([
        "-c",
        "user.name=Pi Integration",
        "-c",
        "user.email=pi-integration@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ]);
      await writeFile(file, current);
      if (state === "already-staged") await git(["add", fileName]);
      const indexBefore = await readFile(path.join(cwd, ".git/index"));
      const change = state === "stale" ? "CHANGE#0000" : selector;
      const run = await new PiIntegrationTest({
        testName: `stage-display-${state}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        rawMode: false,
        tuiSize: { cols: 71, rows: 57 },
        extensions: [path.resolve("src/pi-agent-ide.ts")],
        tools: ["stage"],
        conversation: [
          assistantMessage(
            [toolCall({ id: "stage", name: "stage", arguments: { file: fileName, change } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Stage display checked")]),
        ],
      }).run("Stage one selected change");

      const execution = getToolExecution(run, "stage");
      expect(execution.isError).toBe(state === "stale");
      expect(getToolExecutionDetails(execution)).toMatchObject({ action: "stage", change, file });
      const agentText = getToolResultText(run, "stage");
      expect(agentText).toMatch(
        /^<system-result\b[^>]*><uuid>[a-f\d-]{36}<\/uuid><\/system-result>\n/u,
      );
      const message = agentText.slice(agentText.indexOf("\n") + 1);
      expect(message).toContain(
        state === "applied"
          ? "Staged"
          : state === "already-staged"
            ? "already staged"
            : "not available",
      );
      // Native wrapping may split words. Compare all useful text, not one fixed layout.
      expect(run.tuiRenderedOutput.replaceAll(/\s/gu, "")).toContain(
        message.replaceAll(/\s/gu, ""),
      );
      for (const internal of [
        "<system-result",
        "<uuid>",
        "Internal reference; not part of the file.",
      ])
        expect(run.tuiRenderedOutput).not.toContain(internal);
      await expect(readFile(file, "utf8")).resolves.toBe(current);
      expect((await git(["show", `:${fileName}`])).stdout).toBe(
        state === "stale" ? baseline : current,
      );
      if (state !== "applied")
        await expect(readFile(path.join(cwd, ".git/index"))).resolves.toEqual(indexBefore);
    });
  },
  120_000,
);

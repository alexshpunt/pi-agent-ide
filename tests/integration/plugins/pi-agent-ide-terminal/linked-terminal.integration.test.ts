import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { PiRun } from "pi-coding-agent-test/base";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";
import type { TerminalSessionSnapshot } from "#src/plugins/pi-agent-ide-terminal/src/types.js";

const stereo = process.env.PI_TERMINAL_STEREO;
const layouts = stereo ? ["columns", "rows"] : ["native"];

test.runIf(process.platform !== "win32").each(layouts)(
  "keeps delayed terminal cards at direct and deeply nested launches in %s",
  async (layout) => {
    await withTempWorkspace(async (cwd) => {
      await enableNativeCodemode(cwd);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ disabled: ["ide.lsp", "ide.lint"] }),
      );
      const agent = path.join(cwd, "agent");
      await mkdir(agent);
      await writeFile(
        path.join(agent, "settings.json"),
        JSON.stringify({ quietStartup: true, tuiMode: "fullscreen" }),
      );
      await writeFile(
        path.join(agent, "transcript.json"),
        JSON.stringify({
          mode: "split",
          side: "left",
          chatWidth: 55,
          layout,
          chatHeight: 20,
          zoom: null,
          showTimestamps: false,
        }),
      );
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
      const run = await new PiIntegrationTest({
        testName: `linked-terminal-${layout}`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        timeoutMs: 50_000,
        cwd,
        rawMode: false,
        ...(stereo
          ? {
              isolateUserResources: false,
              environment: {
                PI_CODING_AGENT_DIR: agent,
                PI_TERMINAL_STEREO: stereo,
                PI_TERMINAL_CAPTURE: path.join(
                  testArtifactsDir(import.meta.filename),
                  `linked-terminal-${layout}`,
                  "terminal-panes.json",
                ),
              },
            }
          : {}),
        tuiSize: { cols: 180, rows: 65 },
        extensions: [
          "builtin:codemode",
          path.resolve("src/pi-agent-ide.ts"),
          ...(stereo ? [stereo] : []),
          path.resolve("tests/integration/fixtures/linked-terminal.ts"),
        ],
        tools: ["codemode", "bash", "read", "write", "nested_terminal", "release_terminals"],
        conversation: [
          call("direct-launch", "bash", {
            command: "IFS= read -r answer; printf 'ALPHA-LATE:%s' \"$answer\"",
            background: true,
          }),
          call("outer-launch", "codemode", { code: "text(await tools.nested_terminal({}));" }),
          call("unrelated", "read", { path: "docs:terminal" }),
          call("release", "release_terminals", {}),
          assistantMessage([text("Both terminal jobs completed.")]),
        ],
      }).run("Launch direct and nested terminals; inspect them and release in reverse order.");
      expect(run.exitCode).toBe(0);
      for (const id of ["direct-launch", "outer-launch", "unrelated", "release"])
        expect(getToolExecution(run, id).isError).toBe(false);
      expect(getToolResultText(run, "direct-launch")).toContain("status: running");
      const saved = await PiRun.open(run.artifacts.run);
      type Entry = {
        type: string;
        customType?: string;
        data?: { parentToolCallId?: string; sessions: TerminalSessionSnapshot[] };
        display?: boolean;
        message?: { role?: string; toolCallId?: string };
        details?: { sessions: TerminalSessionSnapshot[] };
      };
      const entries = (saved.session ?? "")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Entry);
      const displays = entries.filter(
        (entry) => entry.type === "custom" && entry.customType === "terminal-completion-display",
      );
      expect(displays).toHaveLength(2);
      expect(displays.map((entry) => entry.data?.parentToolCallId)).toEqual([
        "outer-launch",
        "direct-launch",
      ]);
      for (const entry of displays) {
        const snapshot = entry.data?.sessions[0];
        expect(snapshot?.origin?.parentToolCallId).toBe(entry.data?.parentToolCallId);
        expect(snapshot?.status).toBe("completed");
        expect(snapshot?.output).toContain("accepted");
        expect(snapshot?.origin?.sessionId).toBeTruthy();
      }
      expect(displays[0]?.data?.sessions[0]?.origin?.toolCallId).not.toBe("outer-launch");
      const notices = entries.filter(
        (entry) => entry.type === "custom_message" && entry.customType === "terminal-completion",
      );
      expect(notices.length).toBeGreaterThan(0);
      expect(notices.every((entry) => entry.display === false)).toBe(true);
      expect(notices.flatMap((entry) => entry.details?.sessions ?? [])).toHaveLength(2);
      const modelContext = JSON.stringify(run.providerRequests.at(-1)?.messages);
      for (const marker of ["ALPHA-LATE:accepted", "BETA-LATE:accepted"])
        expect(modelContext.split(marker)).toHaveLength(2);
      const releaseIndex = entries.findIndex(
        (entry) =>
          entry.type === "message" &&
          entry.message?.role === "assistant" &&
          JSON.stringify(entry).includes('"id":"release"'),
      );
      for (const display of displays)
        expect(entries.indexOf(display)).toBeGreaterThan(releaseIndex);
      if (stereo) {
        const capture = JSON.parse(
          await readFile(
            path.join(
              testArtifactsDir(import.meta.filename),
              `linked-terminal-${layout}`,
              "terminal-panes.json",
            ),
            "utf8",
          ),
        ) as {
          panes: Record<string, string[]>;
          search: Record<string, { text: string }[]>;
          screen: string[];
        };
        const activity = stripVTControlCharacters((capture.panes.activity ?? []).join("\n"));
        const chat = stripVTControlCharacters((capture.panes.chat ?? []).join("\n"));
        for (const marker of ["ALPHA-LATE:accepted", "BETA-LATE:accepted"]) {
          // Explicit shell input results also show the final output; only the delayed cards
          // themselves must be unique (the persisted display entries above establish that).
          expect(activity.split(marker).length).toBeGreaterThanOrEqual(2);
          expect(chat).not.toContain(marker);
          expect(capture.search.activity?.some((entry) => entry.text.includes(marker))).toBe(true);
        }
        expect(activity.indexOf("ALPHA-LATE:accepted")).toBeLessThan(
          activity.indexOf("BETA-LATE:accepted"),
        );
        expect(capture.screen.join("\n")).toContain("Activity");
      }
    });
  },
);

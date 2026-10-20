import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { PiRun } from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

const stereo = process.env.PI_AGENT_IDE_TEST_STEREO_EXTENSION;
const clean = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

// The optional consumer is supplied by the verification host, never patched by this suite.
test.skipIf(!stereo).each(["rows", "columns"])(
  "late review stays at direct and deferred nested edits in Stereo %s",
  async (layout) => {
    await mkdir(path.resolve(".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.resolve(".tmp/linked-review-"));
    try {
      const config = path.join(cwd, ".pi/pi-agent-ide");
      await mkdir(config, { recursive: true });
      await writeFile(path.join(cwd, "review-case.json"), JSON.stringify({ mode: "linked" }));
      await writeFile(
        path.join(cwd, ".pi/settings.json"),
        JSON.stringify({ codemode: { mode: "on" } }),
      );
      await writeFile(
        path.join(cwd, ".pi/transcript.json"),
        JSON.stringify({
          mode: "split",
          side: "left",
          chatWidth: 45,
          layout,
          chatHeight: 20,
          zoom: null,
          showTimestamps: false,
        }),
      );
      await writeFile(
        path.join(config, "extensions.json"),
        JSON.stringify({
          preset: "text-editor",
          disabled: ["ide.ast"],
          flags: {
            "pi-agent-ide-code-review": true,
            "pi-agent-ide-no-animations": true,
          },
        }),
      );
      await writeFile(
        path.join(config, "code-review.yaml"),
        "rules:\n  - id: hidden-errors\n    description: Preserve visible operation failures.\n",
      );
      await writeFile(path.join(cwd, "direct.ts"), "throw directError;\n");
      await writeFile(path.join(cwd, "nested.ts"), "throw nestedError;\n");
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" });
      const run = await new PiIntegrationTest({
        testName: `linked-review-${layout}-reload`,
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [
          "builtin:codemode",
          path.resolve("src/pi-agent-ide.ts"),
          ...(stereo ? [stereo] : []),
          path.resolve("tests/integration/code-review/fixture.ts"),
          path.resolve("tests/integration/code-review/capture.ts"),
        ],
        tools: ["codemode", "write", "replace", "read", "wait_review"],
        rawMode: false,
        tuiSize: { cols: 180, rows: 60 },
        timeoutMs: 45_000,
        isolateUserResources: true,
        environment: {
          PI_CODING_AGENT_DIR: path.join(cwd, ".pi"),
          TYPESAFE_API_KEY: "",
          OPENROUTER_API_KEY: "",
        },
        conversation: [
          call("direct-edit", "write", { path: "direct.ts", content: "return null;\n" }),
          call("nested-root", "codemode", {
            code: 'await tools.read({path:"nested.ts"}); const edited = await tools.replace({path:"nested.ts",start:"throw nestedError;",text:"return false;"}); await tools.replace({path:edited,text:"return null;"});',
          }),
          call("unrelated-read", "read", { path: "direct.ts" }),
          call("release", "wait_review", {}),
          assistantMessage([text("Review delivery finished.")]),
        ],
      }).run("/linked-review-reload");
      expect(run.exitCode).toBe(0);
      for (const id of ["direct-edit", "nested-root", "release"])
        expect(getToolExecution(run, id).isError).toBe(false);
      const saved = await PiRun.open(run.artifacts.run);
      const entries = (saved.session ?? "")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              customType?: string;
              details?: { parentToolCallId?: string };
              message?: { customType?: string; details?: { parentToolCallId?: string } };
            },
        );
      const notices = entries.filter(
        (entry) => (entry.message ?? entry).customType === "ide-code-review",
      );
      expect(notices.map((entry) => (entry.message ?? entry).details?.parentToolCallId)).toEqual([
        "direct-edit",
        "nested-root",
      ]);
      const lastRequest = JSON.stringify(run.providerRequests.at(-1)?.messages);
      expect(lastRequest.match(/Jev code review:/g)).toHaveLength(2);
      expect(lastRequest).toContain("Inspected diff:");
      expect(lastRequest).toContain("-throw nestedError;");
      const capture = JSON.parse(await readFile(path.join(cwd, "review-capture.json"), "utf8")) as {
        panes: { activity: string[]; chat: string[] };
        search: { activity: string[]; chat: string[] };
        native: string[];
        reloaded: boolean;
      };
      const activity = clean(capture.panes.activity);
      expect(capture.reloaded).toBe(true);
      const chat = clean(capture.panes.chat);
      expect(activity.match(/Jev code review:/g)).toHaveLength(2);
      expect(chat).not.toContain("Jev code review:");
      expect(capture.search.activity.join("\n").match(/Jev code review:/g)).toHaveLength(2);
      expect(capture.search.chat.join("\n")).not.toContain("Jev code review:");
      const directNotice = activity.indexOf("Jev code review:");
      expect(directNotice).toBeGreaterThan(activity.indexOf("direct.ts"));
      expect(directNotice).toBeLessThan(activity.indexOf("codemode"));
      const nestedNotice = activity.lastIndexOf("Jev code review:");
      expect(nestedNotice).toBeGreaterThan(activity.indexOf("codemode"));
      expect(nestedNotice).toBeLessThan(activity.indexOf("wait_review"));
      const native = clean(capture.native);
      expect(native.indexOf("wait_review")).toBeLessThan(native.indexOf("Jev code review:"));
      // Keep the inspected consumer frames alongside the canonical run, not in source control.
      await writeFile(
        path.join(run.artifacts.directory, "review-capture.json"),
        JSON.stringify(capture),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { testArtifactsDir } from "pi-coding-agent-test";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { piRuntime } from "#capabilities/inventory.ts";
import { runProcess } from "#capabilities/sandbox.ts";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";

interface Content {
  type: string;
  text?: string;
}
interface Result {
  content: Content[];
  details?: unknown;
}
interface Event {
  type: string;
  toolCallId?: string;
  isError?: boolean;
  result?: Result;
  message?: Result & {
    role: string;
    toolCallId?: string;
    isError?: boolean;
    content: (Content & { id?: string; arguments?: Record<string, unknown> })[];
  };
}
interface State {
  abortedPrefixes: string[];
  sentPayloads: string[];
  requests: {
    messages: {
      content: { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[];
    }[];
  }[];
}

test("Anthropic stale prefixes report the guard before validation and recover without executing the prefix", async () => {
  await withTempWorkspace(async (cwd) => {
    const agentDir = path.join(cwd, "agent");
    const home = path.join(cwd, "home");
    const artifacts = path.join(testArtifactsDir(import.meta.filename), "anthropic-stale-prefix");
    await Promise.all([mkdir(agentDir), mkdir(home), mkdir(artifacts, { recursive: true })]);
    await writeFile(path.join(cwd, "note.txt"), "keep\nOLD\nlast\n");
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultTools: ["replace", "insert", "read"],
        retry: { enabled: false, maxRetries: 0 },
      }),
    );
    const runtime = await piRuntime();
    const result = await runProcess(
      process.execPath,
      [
        runtime.cli,
        "--approve",
        "--offline",
        "--mode",
        "json",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-prompt-templates",
        "--no-themes",
        "--no-mcp",
        "-e",
        path.resolve("src/pi-agent-ide.ts"),
        "-e",
        path.resolve("tests/integration/fixtures/anthropic-stale-prefix-provider.ts"),
        "--model",
        "anthropic-stale-prefix-fixture/fixture",
        "--thinking",
        "off",
        "--exclude-tools",
        "edit,grep,find,ls",
        "--pi-agent-ide-no-post-processing",
        "true",
        "--",
        "Run the fixture edit sequence.",
      ],
      {
        cwd,
        timeoutMs: 120_000,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: home,
          PI_CODING_AGENT_DIR: agentDir,
          PI_SKIP_VERSION_CHECK: "1",
          PI_OFFLINE: "1",
          TERM: "xterm-256color",
          LANG: "C.UTF-8",
        },
      },
    );
    await writeFile(path.join(artifacts, "stdout.jsonl"), result.stdout);
    await writeFile(path.join(artifacts, "stderr.log"), result.stderr);
    expect(result.timedOut).toBe(false);
    expect(result.code, result.stderr || result.stdout).toBe(0);
    const stateText = await readFile(path.join(cwd, "anthropic-prefix-state.json"), "utf8");
    await writeFile(path.join(artifacts, "state.json"), stateText);
    const state = JSON.parse(stateText) as State;
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Event);
    expect(state.requests).toHaveLength(7);
    expect(state.abortedPrefixes).toEqual(["stale-2", "stale-3"]);
    expect(state.sentPayloads).toEqual([]);
    for (const id of [...state.abortedPrefixes, "complete-stale"]) {
      const execution = events.find(
        (event) => event.type === "tool_execution_end" && event.toolCallId === id,
      );
      const final = events.find(
        (event) =>
          event.type === "message_end" &&
          event.message?.role === "toolResult" &&
          event.message.toolCallId === id,
      )?.message;
      const call = events
        .flatMap((event) =>
          event.type === "message_end" && event.message?.role === "assistant"
            ? event.message.content
            : [],
        )
        .find((block) => block.type === "toolCall" && block.id === id);
      if (id === "complete-stale") {
        expect(call?.arguments).toHaveProperty("text", "BLOCKED");
        expect(final?.details).not.toHaveProperty("stoppedEarly");
      } else {
        expect(call?.arguments).not.toHaveProperty("text");
        expect(final?.details).toMatchObject({ stoppedEarly: true });
      }
      expect(final).toMatchObject({
        isError: true,
        details: {
          guardId: "stale-anchor",
          effect: "not-applied",
          field: "after",
          path: "note.txt",
          anchor: formatLineHashAnchor("keep\nOLD\nlast\n", 2),
        },
      });
      expect(execution?.isError).toBe(true);
      // All consumers must get the saved refusal, not an incomplete-payload schema error.
      expect(execution?.result?.content).toEqual(final?.content);
      const feedback = state.requests
        .flatMap((request) => request.messages.flatMap((message) => message.content))
        .find((block) => block.type === "tool_result" && block.tool_use_id === id);
      expect(feedback).toMatchObject({
        is_error: true,
        content: final?.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n"),
      });
    }
    const malformed = events.find(
      (event) => event.type === "message_end" && event.message?.toolCallId === "malformed",
    )?.message;
    expect(malformed?.isError).toBe(true);
    expect(malformed?.details).not.toMatchObject({ guardId: "stale-anchor" });
    expect(await readFile(path.join(cwd, "note.txt"), "utf8")).toBe("keep\nNEW\nRECOVERED\nlast\n");
  });
}, 150_000);

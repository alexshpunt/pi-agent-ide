import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";

const fixture = path.resolve("tests/integration/fixtures/standalone-resource-provider.ts");

// Pattern: operation-approval SDK cases. Commands never invoke a model.
test("standalone hosts share approval without sharing owner grants across reload or sessions", async () => {
  await mkdir(".tmp/standalone-resource-host", { recursive: true });
  const cwd = await mkdtemp(path.resolve(".tmp/standalone-resource-host/lifecycle-"));
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const sessionDirectory = path.join(cwd, "sessions");
  const manager = SessionManager.create(cwd, sessionDirectory);
  manager.appendMessage({
    role: "user",
    content: "Standalone approval fixture",
    timestamp: Date.now(),
  });
  // A guide read by the full IDE must not suppress the standalone provider's same-named guide.
  manager.appendCustomEntry("agent-documentation-read", { ids: ["demo"] });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "foreign-guide",
    toolName: "read",
    content: [{ type: "text", text: "An unrelated IDE guide" }],
    details: { documentation: { kind: "attachment", ids: ["demo"] } },
    isError: false,
    timestamp: Date.now(),
  });
  async function launch(sessionManager: SessionManager, mode: "tui" | "print", answer: string) {
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: path.join(cwd, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [fixture],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd,
      settingsManager,
      resourceLoader: loader,
      sessionManager,
      tools: [],
    });
    const select = vi.fn(async () => answer);
    await session.bindExtensions(
      mode === "print"
        ? { mode }
        : {
            mode,
            uiContext: { ...session.extensionRunner.createContext().ui, select },
          },
    );
    return { session, select };
  }
  async function approved(name: string) {
    return JSON.parse(await readFile(path.join(cwd, `approval-${name}.json`), "utf8")) as {
      approved: boolean;
    };
  }
  try {
    const first = await launch(manager, "tui", "Allow for session");
    try {
      const documented = await first.session.extensionRunner.emitToolResult({
        type: "tool_result",
        toolName: "demo_read",
        toolCallId: "provider-guide",
        input: { path: "memory://demo/note" },
        content: [{ type: "text", text: "alpha\nomega" }],
        isError: false,
        details: undefined,
      });
      expect(
        documented?.content?.some(
          (block) => block.type === "text" && block.text.includes("Guide: demo"),
        ),
      ).toBe(true);
      await first.session.prompt("/approval_demo edit");
      await first.session.prompt("/approval_demo edit");
      expect(first.select).toHaveBeenCalledOnce();
      expect(await approved("demo")).toEqual({ approved: true });
      await first.session.prompt("/approval_demo cancel");
      expect(await approved("demo")).toEqual({ approved: false });
      expect(first.select).toHaveBeenCalledOnce();
      const foreignError = {
        role: "toolResult" as const,
        toolCallId: "foreign-error",
        toolName: "read",
        content: [{ type: "text" as const, text: "outside host ".repeat(5000) }],
        isError: true,
        timestamp: Date.now(),
      };
      expect(await first.session.extensionRunner.emitContext([foreignError])).toEqual([
        foreignError,
      ]);
      await first.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    } finally {
      first.session.dispose();
    }
    const restored = await launch(manager, "tui", "Deny");
    try {
      await restored.session.prompt("/approval_demo edit");
      expect(restored.select).not.toHaveBeenCalled();
      expect(await approved("demo")).toEqual({ approved: true });
      await restored.session.prompt("/approval_other edit");
      expect(restored.select).toHaveBeenCalledOnce();
      expect(await approved("other")).toEqual({ approved: false });
      await restored.session.prompt("/approval_demo merge");
      expect(restored.select).toHaveBeenCalledTimes(2);
      expect(await approved("demo")).toEqual({ approved: false });
      await restored.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      restored.session.dispose();
    }
    const file = manager.getSessionFile();
    if (!file) throw new Error("Persistent session file missing");
    const reopened = await launch(SessionManager.open(file, sessionDirectory), "tui", "Deny");
    try {
      await reopened.session.prompt("/approval_demo edit");
      expect(reopened.select).not.toHaveBeenCalled();
      expect(await approved("demo")).toEqual({ approved: true });
      await reopened.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      reopened.session.dispose();
    }
    const separate = await launch(SessionManager.inMemory(cwd), "tui", "Deny");
    try {
      await separate.session.prompt("/approval_demo edit");
      expect(separate.select).toHaveBeenCalledOnce();
      expect(await approved("demo")).toEqual({ approved: false });
      await separate.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      separate.session.dispose();
    }
    const fresh = await launch(SessionManager.inMemory(cwd), "print", "Allow once");
    try {
      await fresh.session.prompt("/approval_demo edit");
      expect(fresh.select).not.toHaveBeenCalled();
      expect(await approved("demo")).toEqual({ approved: false });
      await fresh.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      fresh.session.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90_000);

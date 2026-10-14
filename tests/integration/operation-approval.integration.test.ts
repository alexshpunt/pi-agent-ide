import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
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
import { expect, test, vi } from "vitest";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

const ide = path.resolve("src/pi-agent-ide.ts");
const fixture = path.resolve("tests/integration/support/operation-approval-extension.ts");
const artifacts = testArtifactsDir(import.meta.filename);
interface BlockedState {
  readonly active: boolean;
  readonly label?: string;
}
interface OpenDialog {
  readonly message: string;
  readonly blockedAtOpen?: BlockedState;
  readonly mutationAtOpen: boolean;
}
interface ProbeDetails {
  readonly target: string;
  readonly approved: boolean;
  readonly mode: string;
  readonly hasUI: boolean;
  readonly opened: readonly OpenDialog[];
  readonly blocked: readonly BlockedState[];
  readonly decisions?: readonly boolean[];
  readonly secondOpenedAfterFirst?: boolean;
}
interface ApprovalState {
  readonly effects: readonly string[];
  readonly blocked: readonly BlockedState[];
  readonly opened: readonly OpenDialog[];
}
async function proof(): Promise<Record<string, string>> {
  const sources = [
    "src/pi-agent-ide.ts",
    "src/api/approval.ts",
    "src/extensions/pi-agent-text-editor/index.ts",
    "packages/pi-agent-tool-ui/src/operation-approval.ts",
    "packages/pi-agent-tool-ui/package.json",
    "tests/integration/operation-approval.integration.test.ts",
    "tests/integration/support/operation-approval-extension.ts",
  ];
  return Object.fromEntries(
    await Promise.all(
      sources.map(
        async (source) =>
          [
            source,
            createHash("sha256")
              .update(await readFile(source))
              .digest("hex"),
          ] as const,
      ),
    ),
  );
}
async function readState(cwd: string): Promise<ApprovalState> {
  return JSON.parse(
    await readFile(path.join(cwd, "operation-approval-state.json"), "utf8"),
  ) as ApprovalState;
}

// Separate extension loads are the contract: approval clients must reach the one IDE queue
// regardless of load order, rather than relying on a provider-local module singleton.
test.each(["before", "after"] as const)(
  "shares approval lifecycle through real Pi and Codemode when the client loads %s IDE",
  async (order) => {
    const source = await proof();
    await withTempWorkspace(async (cwd) => {
      await enableNativeCodemode(cwd);
      const direct = (target: string) =>
        assistantMessage(
          [toolCall({ id: target, name: "approval_probe", arguments: { fixture: target } })],
          { stopReason: "toolUse" },
        );
      const run = await new PiIntegrationTest({
        testName: `operation-approval-client-${order}`,
        artifactsDir: artifacts,
        rawMode: false,
        cwd,
        extensions: ["builtin:codemode", ...(order === "before" ? [fixture, ide] : [ide, fixture])],
        tools: ["approval_probe", "codemode"],
        conversation: [
          direct("direct-no"),
          direct("direct-yes"),
          ...["script-no", "script-yes"].map((target) =>
            assistantMessage(
              [
                toolCall({
                  id: target,
                  name: "codemode",
                  arguments: {
                    code: `text(await tools.approval_probe({fixture:${JSON.stringify(target)}}));`,
                  },
                }),
              ],
              { stopReason: "toolUse" },
            ),
          ),
          direct("abort"),
          direct("throw"),
          direct("parallel"),
          assistantMessage([text("Shared operation approval fixture finished.")]),
        ],
      }).run("Exercise the shared approval service with isolated, harmless fixture operations.");
      expect(await proof()).toEqual(source);
      await writeFile(
        path.join(run.artifacts.directory, "approval-source-proof.json"),
        JSON.stringify(source, null, 2),
      );
      const state = await readState(cwd);
      await writeFile(
        path.join(run.artifacts.directory, "approval-state-proof.json"),
        JSON.stringify(state, null, 2),
      );
      for (const target of [
        "direct-no",
        "direct-yes",
        "script-no",
        "script-yes",
        "abort",
        "throw",
        "parallel",
      ])
        expect(getToolExecution(run, target).isError, getToolResultText(run, target)).toBe(false);
      for (const target of ["direct-yes", "script-yes", "parallel"])
        expect(await readFile(path.join(cwd, `${target}.effect`), "utf8")).toBe(target);
      for (const target of ["direct-no", "script-no", "abort", "throw"])
        await expect(access(path.join(cwd, `${target}.effect`))).rejects.toMatchObject({
          code: "ENOENT",
        });
      expect(state.effects).toEqual(["direct-yes", "script-yes", "parallel"]);
      expect(state.opened.map((dialog) => dialog.message)).toEqual([
        "direct-no",
        "direct-yes",
        "script-no",
        "script-yes",
        "abort",
        "throw",
        "parallel-first",
        "parallel-second",
      ]);
      for (const dialog of state.opened) {
        expect(dialog.blockedAtOpen).toMatchObject({ active: true });
        expect(dialog.mutationAtOpen).toBe(false);
      }
      expect(state.blocked.map(({ active }) => active)).toEqual(
        Array.from({ length: 8 }, () => [true, false]).flat(),
      );
      const parallel = getToolExecutionDetails(getToolExecution(run, "parallel")) as ProbeDetails;
      expect(parallel).toMatchObject({ decisions: [true, false], secondOpenedAfterFirst: true });
      expect(parallel.opened).toHaveLength(2);
      expect(parallel.blocked.map(({ active }) => active)).toEqual([true, false, true, false]);
      expect(run.tuiRenderedOutput).toContain("parallel: applied");
      expect(run.tuiRenderedOutput).toContain("Shared operation approval fixture finished.");
      expect(run.tuiRenderedOutput).not.toContain("Failed to load extension");
    });
  },
  90_000,
);

test("runtime shutdown refuses the active and queued approval and closes its waiting state", async () => {
  const source = await proof();
  await withTempWorkspace(async (cwd) => {
    const agentDir = path.join(cwd, "agent");
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [ide, fixture],
    });
    let dispose: (() => void) | undefined;
    let lateAnswer: ((answer: string) => void) | undefined;
    let dialogSignal: AbortSignal | undefined;
    let markOpened: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      markOpened = resolve;
    });
    const messages: string[] = [];
    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["approval_probe"],
      });
      dispose = () => session.dispose();
      const baseUI = session.extensionRunner.createContext().ui;
      await session.bindExtensions({
        mode: "tui",
        uiContext: {
          ...baseUI,
          select(title, _choices, options) {
            messages.push(title.split("\n")[1] ?? "");
            dialogSignal = options?.signal;
            markOpened();
            return new Promise<string>((resolve) => {
              lateAnswer = resolve;
            });
          },
        },
      });
      const command = session.prompt("/approval_cleanup_probe");
      await opened;
      expect(messages).toEqual(["cleanup-current"]);
      expect(dialogSignal?.aborted).toBe(false);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      await command;
      expect(dialogSignal?.aborted).toBe(true);
      expect(messages).toEqual(["cleanup-current"]);
      expect(
        JSON.parse(
          await readFile(path.join(cwd, "approval-cleanup-result.json"), "utf8"),
        ) as unknown,
      ).toEqual([false, false]);
      const state = await readState(cwd);
      expect(state.effects).toEqual([]);
      expect(state.blocked.map(({ active }) => active)).toEqual([true, false]);
      await expect(access(path.join(cwd, "unexpected-cleanup.effect"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await proof()).toEqual(source);
      const directory = path.join(artifacts, "operation-approval-shutdown");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "approval-source-proof.json"),
        JSON.stringify(source, null, 2),
      );
      await writeFile(
        path.join(directory, "approval-state-proof.json"),
        JSON.stringify(state, null, 2),
      );
    } finally {
      lateAnswer?.("Allow once");
      dispose?.();
    }
  });
}, 90_000);
test("real Pi restores session permission after runtime reload and saved-session reopening", async () => {
  await withTempWorkspace(async (cwd) => {
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const sessionDirectory = path.join(cwd, "sessions");
    const manager = SessionManager.create(cwd, sessionDirectory);
    manager.appendMessage({
      role: "user",
      content: "Permission persistence fixture.",
      timestamp: Date.now(),
    });
    async function launch(sessionManager: SessionManager, answer: string) {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: path.join(cwd, "agent"),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: [ide, fixture],
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
      await session.bindExtensions({
        mode: "tui",
        uiContext: { ...session.extensionRunner.createContext().ui, select },
      });
      return { session, select };
    }
    const first = await launch(manager, "Allow for session");
    try {
      await first.session.prompt("/approval_session_probe delete");
      expect(first.select).toHaveBeenCalledOnce();
      const grants = manager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "pi-agent-ide/operation-permission/v1",
        );
      expect(grants).toHaveLength(1);
      await first.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
    } finally {
      first.session.dispose();
    }
    const restored = await launch(manager, "Deny");
    try {
      await restored.session.prompt("/approval_session_probe delete");
      expect(restored.select).not.toHaveBeenCalled();
      expect(
        JSON.parse(await readFile(path.join(cwd, "session-permission-result.json"), "utf8")),
      ).toEqual({ approved: true });
      await restored.session.prompt("/approval_session_probe merge");
      expect(restored.select).toHaveBeenCalledOnce();
      expect(
        JSON.parse(await readFile(path.join(cwd, "session-permission-result.json"), "utf8")),
      ).toEqual({ approved: false });
    } finally {
      restored.session.dispose();
    }
    const savedFile = manager.getSessionFile();
    if (!savedFile) throw new Error("Persistent session did not expose its file");
    const reopened = await launch(SessionManager.open(savedFile, sessionDirectory), "Deny");
    try {
      await reopened.session.prompt("/approval_session_probe delete");
      expect(reopened.select).not.toHaveBeenCalled();
      expect(
        JSON.parse(await readFile(path.join(cwd, "session-permission-result.json"), "utf8")),
      ).toEqual({ approved: true });
    } finally {
      reopened.session.dispose();
    }
    const fresh = await launch(SessionManager.inMemory(cwd), "Deny");
    try {
      await fresh.session.prompt("/approval_session_probe delete");
      expect(fresh.select).toHaveBeenCalledOnce();
      expect(
        JSON.parse(await readFile(path.join(cwd, "session-permission-result.json"), "utf8")),
      ).toEqual({ approved: false });
    } finally {
      fresh.session.dispose();
    }
  });
}, 90_000);
// RPC is dialog-capable. A print-bound SDK agent provides a genuinely unattended Pi context.
test.each(["before", "after"] as const)(
  "real Pi honors explicit YOLO overrides with client loaded %s IDE",
  async (order) => {
    await withTempWorkspace(async (cwd) => {
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: path.join(cwd, "agent"),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        additionalExtensionPaths: order === "before" ? [fixture, ide] : [ide, fixture],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({
        cwd,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [],
      });
      try {
        await session.bindExtensions({ mode: "print" });
        const directory = path.join(cwd, ".pi/pi-agent-ide");
        await mkdir(directory, { recursive: true });
        for (const [common, override, approved] of [
          [false, undefined, false],
          [true, undefined, true],
          [true, false, false],
          [false, true, true],
        ] as const) {
          await writeFile(
            path.join(directory, "extensions.json"),
            JSON.stringify({
              flags: {
                "pi-agent-ide-yolo": common,
                ...(override === undefined ? {} : { "fixture-yolo": override }),
              },
            }),
          );
          await session.prompt("/approval_yolo_probe");
          expect(JSON.parse(await readFile(path.join(cwd, "yolo-result.json"), "utf8"))).toEqual({
            approved,
            hasUI: false,
          });
        }
      } finally {
        session.dispose();
      }
    });
  },
  90_000,
);
test("a real headless Pi agent refuses shared approval without UI, waiting events or effects", async () => {
  const source = await proof();
  await withTempWorkspace(async (cwd) => {
    const agentDir = path.join(cwd, "agent");
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: "approval-fixture",
      defaultModel: "headless",
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [ide, fixture],
    });
    let dispose: (() => void) | undefined;
    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["approval_probe"],
      });
      dispose = () => session.dispose();
      await session.bindExtensions({ mode: "print" });
      const model = session.modelRuntime.getModel("approval-fixture", "headless");
      if (model === undefined) throw Error("Local headless fixture model was not registered");
      await session.setModel(model, { persist: false });
      await session.prompt("Request approval in this unattended fixture session.");
      const result = session.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "headless-approval",
      );
      if (result === undefined || result.role !== "toolResult")
        throw Error("Headless agent did not execute approval probe");
      expect(result.isError).toBe(false);
      expect(result.details).toMatchObject({
        target: "headless",
        approved: false,
        hasUI: false,
        mode: "print",
        opened: [],
        blocked: [],
      });
      const state = await readState(cwd);
      expect(state).toEqual({ effects: [], opened: [], blocked: [] });
      await expect(access(path.join(cwd, "headless.effect"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await proof()).toEqual(source);
      const directory = path.join(artifacts, "operation-approval-headless");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "approval-source-proof.json"),
        JSON.stringify(source, null, 2),
      );
      await writeFile(path.join(directory, "tool-result.json"), JSON.stringify(result, null, 2));
      await writeFile(
        path.join(directory, "approval-state-proof.json"),
        JSON.stringify(state, null, 2),
      );
    } finally {
      dispose?.();
    }
  });
}, 90_000);

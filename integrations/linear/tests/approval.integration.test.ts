import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { currentIde } from "./fixtures/current-ide.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";

interface ApprovalState {
  waiting: { active: boolean; label?: string }[];
  decisions: {
    message: string;
    blockedAtOpen: { active: boolean };
    cancelled: boolean;
  }[];
  mutations: { input: { note?: string }; operation: string }[];
}

/** Load the fixture's recorded user decisions, backend calls and waiting events. */
async function loadApprovalState(cwd: string): Promise<ApprovalState> {
  return JSON.parse(await readFile(path.join(cwd, "approval-state.json"), "utf8")) as ApprovalState;
}
const fixture = path.join(root, "tests/fixtures/approval-provider.ts");
const artifacts = testArtifactsDir(import.meta.filename);

async function sourceProof() {
  const api = await realpath(fileURLToPath(import.meta.resolve("pi-agent-ide/api/approval")));
  const { extension, source: ide, version } = await currentIde();
  const service = await realpath(
    createRequire(path.join(ide, "package.json")).resolve("pi-agent-tool-ui/operation-approval"),
  );
  const hash = async (file: string) =>
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
  return {
    ide,
    extension,
    version,
    api,
    service,
    apiSha256: await hash(api),
    serviceSha256: await hash(service),
    policySha256: await hash(path.join(root, "src/operation-actions.ts")),
  };
}
// Remembering merge permission must not also authorize comment deletion.
test("Linear remembers only the selected provider dialog category", async () => {
  const source = await sourceProof();
  const cwd = await workspace();
  try {
    const calls = [
      toolCall({
        id: "remember",
        name: "write",
        arguments: {
          path: "linear://example/diff/remember-session#merge",
          content: '{"note":"remember-session"}',
        },
      }),
      toolCall({
        id: "remembered",
        name: "write",
        arguments: {
          path: "linear://example/diff/session-refuse#merge",
          content: '{"note":"session-refuse"}',
        },
      }),
      toolCall({
        id: "other-category",
        name: "delete",
        arguments: {
          path: "linear://example/comment/delete-refuse",
        },
      }),
    ];
    const run = await new PiIntegrationTest({
      testName: "linear-session-permission",
      artifactsDir: artifacts,
      cwd,
      isolateUserResources: true,
      extensions: [source.extension, fixture],
      tools: ["write", "delete"],
      conversation: [
        ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
        assistantMessage([text("Finished controlled Linear session permission.")]),
      ],
    }).run("Remember merge approval within this session, not comment deletion.");
    for (const id of ["remember", "remembered"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    expect(getToolResultText(run, "other-category")).toContain("LINEAR_CONFIRMATION_REQUIRED");
    const state = await loadApprovalState(cwd);
    expect(state.mutations).toEqual([
      { operation: "merge_diff", input: { urlOrId: "remember-session", note: "remember-session" } },
      { operation: "merge_diff", input: { urlOrId: "session-refuse", note: "session-refuse" } },
    ]);
    expect(state.decisions).toHaveLength(2);
    expect(state.decisions.some((decision) => decision.message.includes("session-refuse"))).toBe(
      false,
    );
    expect(state.waiting.map(({ active }) => ({ active }))).toEqual(
      state.decisions.flatMap(() => [{ active: true }, { active: false }]),
    );
    expect(run.tuiRenderedOutput).not.toContain("Failed to load extension");
    expect(await sourceProof()).toEqual(source);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 90000);
async function workspace() {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  return mkdtemp(path.join(root, ".tmp/linear-approval-"));
}
function resultText(outcome: { content: { type: string; text?: string }[] }) {
  return outcome.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// Pattern: real extension loader and ordinary shared tools; only backend and user answer are controlled.
// Contract: shared waiting lifecycle wraps production Linear risk policy on direct/native Codemode paths.
test.each([false, true])(
  "Linear uses shared approval on both routes and load orders (providerFirst=%s)",
  async (providerFirst) => {
    const source = await sourceProof();
    const cwd = await workspace();
    const ideExtension = source.extension;
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { enabled: true } }),
    );
    try {
      const calls = [
        toolCall({
          id: "schema",
          name: "read",
          arguments: { path: "linear://example/diff/schema#merge" },
        }),
        toolCall({
          id: "low-risk",
          name: "write",
          arguments: {
            path: "linear://example/comment/new",
            content: '{"body":"Low-risk creation"}',
          },
        }),
        toolCall({
          id: "write-no",
          name: "write",
          arguments: {
            path: "linear://example/diff/direct-refuse#merge",
            content: '{"note":"direct-refuse"}',
          },
        }),
        toolCall({
          id: "write-yes",
          name: "write",
          arguments: {
            path: "linear://example/diff/direct-yes#merge",
            content: '{"note":"direct-yes"}',
          },
        }),
        toolCall({
          id: "delete-no",
          name: "delete",
          arguments: { path: "linear://example/comment/direct-refuse" },
        }),
        toolCall({
          id: "delete-yes",
          name: "delete",
          arguments: { path: "linear://example/comment/direct-yes" },
        }),
        toolCall({
          id: "script",
          name: "codemode",
          arguments: {
            code: `
        for (const target of ["script-refuse", "script-yes"]) {
          const write = {path:"linear://example/diff/"+target+"#merge",content:JSON.stringify({note:target})};
          const remove = {path:"linear://example/comment/"+target};
          for (const [name,args] of [["write",write],["delete",remove]]) {
            let failed=false;
            try { text(await tools[name](args)); } catch { failed=true; }
            if (failed !== target.includes("refuse")) throw Error("Wrong approval decision: "+target+" "+name);
          }
        }
      `,
          },
        }),
        toolCall({ id: "lifecycle", name: "linear_approval_probe", arguments: {} }),
      ];
      const run = await new PiIntegrationTest({
        testName: `linear-shared-approval-${providerFirst ? "provider-first" : "ide-first"}`,
        artifactsDir: artifacts,
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: providerFirst
          ? ["builtin:codemode", fixture, ideExtension]
          : ["builtin:codemode", ideExtension, fixture],
        tools: ["write", "delete", "read", "codemode", "linear_approval_probe"],
        timeoutMs: 60000,
        conversation: [
          ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
          assistantMessage([text("Finished approval checks.")]),
        ],
      }).run("Confirm only explicitly approved controlled Linear operations.");
      expect(await sourceProof()).toEqual(source);
      await writeFile(
        path.join(run.artifacts.directory, "approval-source.json"),
        JSON.stringify(source, null, 2),
      );
      for (const id of ["schema", "low-risk", "write-yes", "delete-yes", "script", "lifecycle"])
        expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      for (const id of ["write-no", "delete-no"]) {
        expect(getToolExecution(run, id).isError).toBe(true);
        expect(getToolResultText(run, id)).toContain("LINEAR_CONFIRMATION_REQUIRED");
      }
      const state = await loadApprovalState(cwd);
      await writeFile(
        path.join(run.artifacts.directory, "approval-state.json"),
        JSON.stringify(state, null, 2),
      );
      expect(state.mutations).toEqual([
        { operation: "save_comment", input: { body: "Low-risk creation" } },
        { operation: "merge_diff", input: { urlOrId: "direct-yes", note: "direct-yes" } },
        { operation: "delete_comment", input: { id: "direct-yes" } },
        { operation: "merge_diff", input: { urlOrId: "script-yes", note: "script-yes" } },
        { operation: "delete_comment", input: { id: "script-yes" } },
      ]);
      expect(state.decisions).toHaveLength(10);
      expect(state.decisions.every((decision) => decision.blockedAtOpen.active)).toBe(true);
      // Pi tool_call receives the active-turn context, not a child executeTool signal override.
      // Keep the child cancellation regression about effects, and record the dialog limitation.
      expect(state.mutations.some((entry) => entry.input.note === "abort")).toBe(false);
      expect(state.waiting.map(({ active }) => ({ active }))).toEqual(
        state.decisions.flatMap(() => [{ active: true }, { active: false }]),
      );
      const lifecycle = getToolExecutionDetails(getToolExecution(run, "lifecycle")) as {
        mode: string;
        hasUI: boolean;
        calls: { isError: boolean; text: string }[];
        consumed: boolean[];
      };
      expect(lifecycle).toMatchObject({
        mode: "tui",
        hasUI: true,
        consumed: [true, true, true, true],
      });
      expect(lifecycle.calls).toHaveLength(2);
      expect(lifecycle.calls.every((call) => call.isError)).toBe(true);
      await writeFile(
        path.join(run.artifacts.directory, "child-signal-limitation.json"),
        JSON.stringify(
          {
            scope:
              "tool_call context.signal is the current turn signal, not executeTool child signal",
            childOperationRejected: lifecycle.calls[0]?.isError,
            hookDialogSignalCancelled: state.decisions.find((decision) =>
              decision.message.includes("/abort#merge"),
            )?.cancelled,
            backendDispatchesForAbortedChild: state.mutations.filter(
              (entry) => entry.input.note === "abort",
            ).length,
          },
          null,
          2,
        ),
      );
      expect(lifecycle.calls[1]?.text).toContain("LINEAR_CONFIRMATION_REQUIRED");
      expect(run.tuiRenderedOutput).not.toContain("Failed to load extension");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);

test("current-turn cancellation closes Linear approval, ignores late yes and permits a later run", async () => {
  const source = await sourceProof();
  const cwd = await workspace();
  const ideExtension = source.extension;
  try {
    const cancelled = await new PiIntegrationTest({
      testName: "linear-approval-current-turn-cancelled",
      artifactsDir: artifacts,
      cwd,
      isolateUserResources: true,
      rawMode: false,
      extensions: [ideExtension, fixture],
      tools: ["write"],
      timeoutMs: 60000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "turn-cancelled",
              name: "write",
              arguments: {
                path: "linear://example/diff/turn-abort#merge",
                content: '{"note":"turn-abort"}',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ],
    }).run("Abort the current turn while the controlled Linear permission dialog is open.");
    expect(await sourceProof()).toEqual(source);
    const cancelledState = await loadApprovalState(cwd);
    await Promise.all([
      writeFile(
        path.join(cancelled.artifacts.directory, "approval-state.json"),
        JSON.stringify(cancelledState, null, 2),
      ),
      writeFile(
        path.join(cancelled.artifacts.directory, "approval-source.json"),
        JSON.stringify(source, null, 2),
      ),
    ]);
    expect(getToolExecution(cancelled, "turn-cancelled").isError).toBe(true);
    expect(cancelledState.mutations).toEqual([]);
    expect(cancelledState.decisions).toHaveLength(1);
    expect(cancelledState.decisions[0]).toMatchObject({
      approved: true,
      cancelled: true,
      mutationsBefore: 0,
      blockedAtOpen: { active: true },
    });
    expect(cancelledState.waiting.map(({ active }) => ({ active }))).toEqual([
      { active: true },
      { active: false },
    ]);

    // An aborted scripted turn cannot request its next model response; start a fresh real run.
    const allowed = await new PiIntegrationTest({
      testName: "linear-approval-after-turn-cancelled",
      artifactsDir: artifacts,
      cwd,
      isolateUserResources: true,
      rawMode: false,
      extensions: [fixture, ideExtension],
      tools: ["write"],
      timeoutMs: 60000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "after-cancel-yes",
              name: "write",
              arguments: {
                path: "linear://example/diff/after-cancel-yes#merge",
                content: '{"note":"after-cancel-yes"}',
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Fresh operation approved.")]),
      ],
    }).run("Approve a fresh controlled Linear operation after the cancelled run.");
    expect(await sourceProof()).toEqual(source);
    const allowedState = await loadApprovalState(cwd);
    await Promise.all([
      writeFile(
        path.join(allowed.artifacts.directory, "approval-state.json"),
        JSON.stringify(allowedState, null, 2),
      ),
      writeFile(
        path.join(allowed.artifacts.directory, "approval-source.json"),
        JSON.stringify(source, null, 2),
      ),
    ]);
    expect(
      getToolExecution(allowed, "after-cancel-yes").isError,
      getToolResultText(allowed, "after-cancel-yes"),
    ).toBe(false);
    expect(allowedState.mutations).toEqual([
      { operation: "merge_diff", input: { urlOrId: "after-cancel-yes", note: "after-cancel-yes" } },
    ]);
    expect(allowedState.decisions).toHaveLength(1);
    expect(allowedState.decisions[0]).toMatchObject({
      approved: true,
      cancelled: false,
      blockedAtOpen: { active: true },
    });
    expect(allowedState.waiting.map(({ active }) => ({ active }))).toEqual([
      { active: true },
      { active: false },
    ]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);
test.each([
  { name: "default-off", flags: {}, allowed: false },
  { name: "common-on", flags: { "pi-agent-ide-yolo": true }, allowed: true },
  {
    name: "provider-on",
    flags: { "pi-agent-ide-yolo": false, "pi-agent-linear-yolo": true },
    allowed: true,
  },
  {
    name: "provider-off",
    flags: { "pi-agent-ide-yolo": true, "pi-agent-linear-yolo": false },
    allowed: false,
  },
])(
  "headless real Pi applies Linear approval policy: $name",
  async ({ name, flags, allowed }) => {
    const source = await sourceProof();
    const cwd = await workspace();
    const directory = path.join(artifacts, `linear-approval-headless-${name}`);
    await mkdir(directory, { recursive: true });
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(path.join(cwd, ".pi/pi-agent-ide/extensions.json"), JSON.stringify({ flags }));
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
      additionalExtensionPaths: [source.extension, fixture],
    });
    let dispose: (() => void) | undefined;
    vi.stubEnv("PI_CODING_AGENT_DIR", path.join(cwd, "agent"));
    try {
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({
        cwd,
        agentDir: path.join(cwd, "agent"),
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: ["write", "delete", "linear_approval_probe"],
      });
      dispose = () => session.dispose();
      await session.bindExtensions({ mode: "print" });
      const model = session.modelRuntime.getModel("linear-approval-fixture", "headless");
      if (!model) throw new Error("Local headless fixture model missing");
      await session.setModel(model, { persist: false });
      await session.prompt("Verify the configured unattended Linear permission policy.");
      const result = session.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "headless-approval",
      );
      if (!result || result.role !== "toolResult") throw new Error("Headless probe did not run");
      expect(result.isError, resultText(result)).toBe(false);
      const details = result.details as {
        mode: string;
        hasUI: boolean;
        calls: { isError: boolean; text: string }[];
      };
      expect(details).toMatchObject({ mode: "print", hasUI: false });
      expect(details.calls).toHaveLength(4);
      for (const call of details.calls.slice(0, 3)) {
        expect(call.isError, call.text).toBe(!allowed);
        if (!allowed) expect(call.text).toContain("LINEAR_CONFIRMATION_REQUIRED");
      }
      expect(details.calls[3]?.isError).toBe(true);
      expect(details.calls[3]?.text).toContain(
        allowed ? "LINEAR_IDENTITY_OVERRIDE" : "LINEAR_CONFIRMATION_REQUIRED",
      );
      const state = await loadApprovalState(cwd);
      expect(state).toMatchObject({
        waiting: [],
        decisions: [],
        mutations: allowed
          ? [
              { operation: "merge_diff", input: { urlOrId: "headless", note: "headless" } },
              {
                operation: "merge_diff",
                input: { urlOrId: "headless-refuse", note: "headless-refuse" },
              },
              { operation: "delete_comment", input: { id: "headless-refuse" } },
            ]
          : [],
        observations: [{ mode: "print", hasUI: false }],
      });
      expect(await sourceProof()).toEqual(source);
      await Promise.all([
        writeFile(path.join(directory, "approval-source.json"), JSON.stringify(source, null, 2)),
        writeFile(path.join(directory, "approval-state.json"), JSON.stringify(state, null, 2)),
        writeFile(path.join(directory, "tool-result.json"), JSON.stringify(result, null, 2)),
      ]);
    } finally {
      dispose?.();
      vi.unstubAllEnvs();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);

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
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { githubPackageRoot } from "./fixtures/package-root.ts";
import { currentIde } from "./fixtures/current-ide.ts";
import { headSha, initialPullsState, type PullsState } from "./fixtures/pulls-provider.ts";

interface ApprovalLifecycle {
  waiting: { active: boolean }[];
  decisions: { message: string; waiting: { active: boolean } }[];
}

const root = githubPackageRoot;
const fixture = path.join(root, "tests/fixtures/approval-provider.ts");
const artifacts = testArtifactsDir(import.meta.filename);
const reviewSource = "github://example/project/pulls/12/reviews/new";

// Use a real print runtime: rawMode changes rendering, not hasUI.
test.each([
  { allowed: false, standalone: false },
  { allowed: true, standalone: false },
  { allowed: false, standalone: true },
  { allowed: true, standalone: true },
])(
  "headless real Pi applies GitHub provider YOLO (allowed=$allowed, standalone=$standalone)",
  async ({ allowed, standalone }) => {
    const permitsActions = standalone || allowed;
    const { extension: ideExtension } = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/github-headless-yolo-"));
    let dispose: (() => void) | undefined;
    try {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({
          flags: { "pi-agent-ide-yolo": false, "pi-agent-github-yolo": allowed },
        }),
      );
      await writeFile(path.join(cwd, "pulls-fixture.json"), JSON.stringify(initialPullsState()));
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
        additionalExtensionPaths: standalone ? [fixture] : [ideExtension, fixture],
      });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        settingsManager,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [standalone ? "github_write" : "write", "verify_pull_headless"],
      });
      dispose = () => session.dispose();
      await session.bindExtensions({ mode: "print" });
      const model = session.modelRuntime.getModel("pulls-fixture", "headless");
      if (!model) throw new Error("Local headless GitHub fixture model missing");
      await session.setModel(model, { persist: false });
      await session.prompt("Check configured unattended GitHub action permissions.");
      const result = session.messages.find(
        (message) => message.role === "toolResult" && message.toolCallId === "headless-probe",
      );
      if (!result || result.role !== "toolResult")
        throw new Error("Headless GitHub probe did not run");
      expect(result.isError).toBe(false);
      const details = result.details as {
        hasUI: boolean;
        mode: string;
        calls: { isError: boolean; result: { content: { type: string; text?: string }[] } }[];
      };
      expect(details).toMatchObject({ hasUI: false, mode: "print" });
      expect(details.calls).toHaveLength(3);
      for (const call of details.calls) {
        const output = call.result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        if (permitsActions) expect(output).not.toContain("GH_APPROVAL_REQUIRED");
        else {
          expect(call.isError).toBe(true);
          expect(output).toContain("GH_APPROVAL_REQUIRED");
        }
      }
      expect(details.calls[2]?.isError).toBe(!permitsActions);
      const state = JSON.parse(
        await readFile(path.join(cwd, "pulls-fixture.json"), "utf8"),
      ) as PullsState;
      expect(
        state.requests
          .filter((request) => request.method === "POST" && request.path.endsWith("/reviews"))
          .map((request) => request.body?.body),
      ).toEqual(permitsActions ? ["Immediate approval"] : []);
      if (!permitsActions) expect(state.requests).toEqual([]);
      const lifecycle = JSON.parse(
        await readFile(path.join(cwd, "approval-state.json"), "utf8"),
      ) as ApprovalLifecycle;
      expect(lifecycle).toEqual({ waiting: [], decisions: [] });
    } finally {
      dispose?.();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);

// Saved provider overrides must win over the common switch; defaults remain guarded.
test.each([
  { name: "default-off", flags: {}, allowed: false },
  { name: "common-on", flags: { "pi-agent-ide-yolo": true }, allowed: true },
  {
    name: "provider-on",
    flags: { "pi-agent-ide-yolo": false, "pi-agent-github-yolo": true },
    allowed: true,
  },
  {
    name: "provider-off",
    flags: { "pi-agent-ide-yolo": true, "pi-agent-github-yolo": false },
    allowed: false,
  },
])(
  "GitHub approval policy: $name",
  async ({ name, flags, allowed }) => {
    const { extension: ideExtension } = await currentIde();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/github-yolo-"));
    try {
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ flags }),
      );
      await writeFile(path.join(cwd, "pulls-fixture.json"), JSON.stringify(initialPullsState()));
      const run = await new PiIntegrationTest({
        testName: `github-yolo-${name}`,
        artifactsDir: artifacts,
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [ideExtension, fixture],
        tools: ["read", "write"],
        conversation: [
          assistantMessage(
            [toolCall({ id: "schema", name: "read", arguments: { path: reviewSource } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "gated",
                name: "write",
                arguments: {
                  path: reviewSource,
                  content: JSON.stringify({
                    body: "config-refuse",
                    commit_id: headSha,
                    event: "COMMENT",
                  }),
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: "invalid",
                name: "write",
                arguments: {
                  path: reviewSource,
                  content: JSON.stringify({
                    body: "invalid-refuse",
                    commit_id: headSha,
                    event: "INVALID",
                  }),
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Finished controlled GitHub policy checks.")]),
        ],
      }).run("Check saved GitHub YOLO policy and retain payload validation.");
      expect(getToolExecution(run, "gated").isError, getToolResultText(run, "gated")).toBe(
        !allowed,
      );
      if (!allowed) expect(getToolResultText(run, "gated")).toContain("GH_APPROVAL_REQUIRED");
      expect(getToolExecution(run, "invalid").isError).toBe(true);
      const state = JSON.parse(
        await readFile(path.join(cwd, "pulls-fixture.json"), "utf8"),
      ) as PullsState;
      expect(
        state.requests
          .filter((request) => request.method === "POST")
          .map((request) => request.body?.body),
      ).toEqual(allowed ? ["config-refuse"] : []);
      const lifecycle = JSON.parse(
        await readFile(path.join(cwd, "approval-state.json"), "utf8"),
      ) as ApprovalLifecycle;
      expect(lifecycle.decisions).toHaveLength(allowed ? 0 : 2);
      expect(lifecycle.waiting.map(({ active }) => active)).toEqual(
        allowed ? [] : lifecycle.decisions.flatMap(() => [true, false]),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);

// Pattern: real tool_call hook and shared IDE service; only HTTP and user decisions are controlled.
test.each(["standalone", "provider-first", "ide-first"] as const)(
  "GitHub shares terminal approvals in each automatic mode (%s)",
  async (mode) => {
    const providerFirst = mode === "provider-first";
    const standalone = mode === "standalone";
    const toolName = (name: string) =>
      standalone && name !== "codemode" ? "github_" + name : name;
    const { extension: ideExtension } = await currentIde();
    const api = await realpath(fileURLToPath(import.meta.resolve("pi-agent-ide/api/approval")));
    const service = createRequire(ideExtension).resolve("pi-agent-tool-ui/operation-approval");
    const sources = [api, service, path.join(root, "src/index.ts")];
    const proof = async () =>
      Promise.all(
        sources.map(async (file) => ({
          file,
          sha256: createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        })),
      );
    const source = await proof();
    await mkdir(path.join(root, ".tmp"), { recursive: true });
    const cwd = await mkdtemp(path.join(root, ".tmp/github-approval-"));
    await mkdir(path.join(cwd, ".pi"));
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { enabled: true } }),
    );
    await writeFile(path.join(cwd, "pulls-fixture.json"), JSON.stringify(initialPullsState()));
    const review = (body: string, immediate = true) => ({
      path: reviewSource,
      content: JSON.stringify({
        body,
        commit_id: headSha,
        ...(immediate ? { event: "COMMENT" } : {}),
      }),
    });
    try {
      const calls = [
        toolCall({ id: "schema", name: "read", arguments: { path: reviewSource } }),
        toolCall({ id: "pending", name: "write", arguments: review("pending", false) }),
        toolCall({ id: "refused", name: "write", arguments: review("refuse") }),
        toolCall({ id: "approved", name: "write", arguments: review("direct-approved") }),
        toolCall({ id: "failure", name: "write", arguments: review("dialog-failure") }),
        toolCall({
          id: "script",
          name: "codemode",
          arguments: {
            code: `
        for (const body of ["script-refuse", "script-approved"]) {
          let failed = false;
          try { text(await tools.write({
            path: "${reviewSource}",
            content: JSON.stringify({body,commit_id:"${headSha}",event:"COMMENT"})
          })); } catch { failed = true; }
          if (failed !== body.includes("refuse")) throw Error("Wrong shared decision: "+body);
        }
      `,
          },
        }),
        toolCall({
          id: "raw-yolo",
          name: "write",
          arguments: {
            path: "github://api/rest",
            content: JSON.stringify({
              method: "POST",
              path: "/repos/example/project/issues/12/comments",
              body: { body: "raw-yolo" },
            }),
          },
        }),
      ];
      calls.push(
        toolCall({ id: "remember", name: "write", arguments: review("remember-session") }),
        toolCall({ id: "remembered", name: "write", arguments: review("session-refuse") }),
        toolCall({
          id: "other-category",
          name: "write",
          arguments: {
            path: "github://example/project/pulls/12/reviews/999/submit",
            content: JSON.stringify({ body: "other-category-refuse", event: "COMMENT" }),
          },
        }),
      );
      const run = await new PiIntegrationTest({
        testName: `github-shared-approval-${mode}`,
        artifactsDir: artifacts,
        cwd,
        isolateUserResources: true,
        rawMode: false,
        extensions: standalone
          ? ["builtin:codemode", fixture]
          : providerFirst
            ? ["builtin:codemode", fixture, ideExtension]
            : ["builtin:codemode", ideExtension, fixture],
        tools: ["read", "write", "codemode"].map(toolName),
        timeoutMs: 60000,
        conversation: [
          ...calls.map((call) =>
            assistantMessage(
              [
                toolCall({
                  id: call.id,
                  name: toolName(call.name),
                  arguments:
                    standalone && call.name === "codemode"
                      ? {
                          ...call.arguments,
                          code: String(call.arguments?.code)
                            .replaceAll("tools.write(", "tools.github_write(")
                            .replace('failed !== body.includes("refuse")', "failed !== false"),
                        }
                      : call.arguments,
                }),
              ],
              { stopReason: "toolUse" },
            ),
          ),
          assistantMessage([text("Finished controlled GitHub approvals.")]),
        ],
      }).run("Verify GitHub uses the common dialog without changing raw API YOLO.");
      expect(await proof()).toEqual(source);
      for (const id of [
        "schema",
        "pending",
        "approved",
        "script",
        "raw-yolo",
        "remember",
        "remembered",
      ])
        expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      for (const id of ["refused", "failure"]) {
        expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(!standalone);
        if (!standalone) expect(getToolResultText(run, id)).toContain("GH_APPROVAL_REQUIRED");
      }
      expect(getToolExecution(run, "other-category").isError).toBe(true);
      if (standalone)
        expect(getToolResultText(run, "other-category")).not.toContain("GH_APPROVAL_REQUIRED");
      else expect(getToolResultText(run, "other-category")).toContain("GH_APPROVAL_REQUIRED");
      const state = JSON.parse(
        await readFile(path.join(cwd, "pulls-fixture.json"), "utf8"),
      ) as PullsState;
      const lifecycle = JSON.parse(
        await readFile(path.join(cwd, "approval-state.json"), "utf8"),
      ) as ApprovalLifecycle;
      expect(
        state.requests
          .filter((request) => request.method === "POST")
          .map((request) => request.body?.body),
      ).toEqual(
        standalone
          ? [
              "pending",
              "refuse",
              "direct-approved",
              "dialog-failure",
              "script-refuse",
              "script-approved",
              "raw-yolo",
              "remember-session",
              "session-refuse",
              "other-category-refuse",
            ]
          : [
              "pending",
              "direct-approved",
              "script-approved",
              "raw-yolo",
              "remember-session",
              "session-refuse",
            ],
      );
      expect(lifecycle.decisions).toHaveLength(standalone ? 0 : 7);
      expect(
        lifecycle.decisions.some((decision: { message: string }) =>
          decision.message.includes('"body":"session-refuse"'),
        ),
      ).toBe(false);
      expect(
        lifecycle.decisions.every(
          (decision) =>
            decision.message.includes("github://example/project/pulls/12/reviews/") &&
            decision.waiting.active,
        ),
      ).toBe(true);
      expect(lifecycle.waiting.map(({ active }) => active)).toEqual(
        lifecycle.decisions.flatMap(() => [true, false]),
      );
      await Promise.all([
        writeFile(
          path.join(run.artifacts.directory, "approval-source.json"),
          JSON.stringify(source, null, 2),
        ),
        writeFile(
          path.join(run.artifacts.directory, "approval-state.json"),
          JSON.stringify(lifecycle, null, 2),
        ),
        writeFile(
          path.join(run.artifacts.directory, "http-state.json"),
          JSON.stringify(state, null, 2),
        ),
      ]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);

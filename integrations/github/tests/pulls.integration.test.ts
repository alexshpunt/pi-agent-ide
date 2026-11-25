import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";
import {
  filePath,
  fileText,
  headSha,
  initialPullsState,
  patch,
  type PullsState,
} from "./fixtures/pulls-provider.ts";

import { githubPackageRoot as root } from "./fixtures/package-root.ts";
const fixture = path.join(root, "tests/fixtures/pulls-provider.ts");
const repository = "github://example/project";
const pull = repository + "/pulls/12";
const native = "https://github.com/example/project/pull/12";
const fileSource = repository + "/file?" + new URLSearchParams({ ref: headSha, path: filePath });
const artifacts = testArtifactsDir(import.meta.filename);
const load = async (cwd: string): Promise<PullsState> =>
  JSON.parse(await readFile(path.join(cwd, "pulls-fixture.json"), "utf8")) as PullsState;
async function workspace(existingPull = true) {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "github-pulls-"));
  const state = initialPullsState();
  if (!existingPull) state.pulls = {};
  await writeFile(path.join(cwd, "pulls-fixture.json"), JSON.stringify(state));
  return cwd;
}

// Pattern: extensions example and native shared-tool fixtures; no GitHub CLI or live network.
// Contract: PR collaboration keeps exact identities and file reads bind to the displayed head SHA.
test("real Pi creates and edits PRs, comments and a pending review through shared tools", async () => {
  const ide = await currentIde();
  const cwd = await workspace(false);
  const create = {
    title: "Created PR",
    head: "feature",
    base: "develop",
    body: "Original PR body\n",
    draft: true,
  };
  const inline = {
    body: "Inline feedback",
    commit_id: headSha,
    path: filePath,
    line: 1,
    side: "RIGHT",
  };
  const review = {
    body: "Pending review",
    commit_id: headSha,
    comments: [{ path: filePath, body: "Pending inline", line: 1, side: "RIGHT" }],
  };
  const operations: [string, string, Record<string, unknown>][] = [
    ["pull-guide", "read", { path: "docs:github-pulls" }],
    ["create-schema", "read", { path: repository + "/pulls/new" }],
    ["create", "write", { path: repository + "/pulls/new", content: JSON.stringify(create) }],
    ["native", "read", { path: native }],
    ["body", "read", { path: pull + "#body", views: ["anchors"] }],
    [
      "edit-body",
      "replace",
      { path: pull + "#body", at: "Original PR body", text: "Edited PR body" },
    ],
    ["saved-body", "read", { path: pull + "#body" }],
    ["fields", "read", { path: pull + "#fields" }],
    [
      "edit-fields",
      "write",
      {
        path: pull + "#fields",
        content: JSON.stringify({
          title: "Edited PR title",
          base: "main",
          maintainer_can_modify: false,
        }),
      },
    ],
    ["saved-fields", "read", { path: pull + "#fields" }],
    [
      "conversation",
      "write",
      {
        path: repository + "/issues/12/comments/new",
        content: JSON.stringify({ body: "Conversation feedback" }),
      },
    ],
    ["conversation-native", "read", { path: native + "#issuecomment-101" }],
    ["conversation-body", "read", { path: repository + "/issues/comments/101#body" }],
    ["inline", "write", { path: pull + "/comments/new", content: JSON.stringify(inline) }],
    ["inline-native", "read", { path: native + "#discussion_r201" }],
    [
      "reply",
      "write",
      {
        path: pull + "/comments/201/replies/new",
        content: JSON.stringify({ body: "Inline reply" }),
      },
    ],
    ["reply-native", "read", { path: native + "#discussion_r202" }],
    ["reply-body", "read", { path: repository + "/pulls/comments/202#body" }],
    ["pending", "write", { path: pull + "/reviews/new", content: JSON.stringify(review) }],
    ["review-native", "read", { path: native + "#pullrequestreview-301" }],
    ["review-body", "read", { path: pull + "/reviews/301#body" }],
    ["files", "read", { path: pull + "/files" }],
    ["file", "read", { path: fileSource }],
    ["implicit-file", "read", { path: repository + "/file?path=src%2Fa+b.ts" }],
  ];
  try {
    const result = await new PiIntegrationTest({
      testName: "github-pull-collaboration",
      artifactsDir: artifacts,
      cwd,
      extensions: [ide.extension, fixture],
      isolateUserResources: true,
      rawMode: false,
      tools: ["read", "write", "replace"],
      timeoutMs: 90_000,
      conversation: [
        ...operations.map(([id, name, args]) =>
          assistantMessage([toolCall({ id, name, arguments: args })], { stopReason: "toolUse" }),
        ),
        assistantMessage([text("Finished PR collaboration fixture.")]),
      ],
    }).run("Use ordinary resource tools for PR collaboration and explicit file reads.");
    await ide.record(result.artifacts.directory);
    const state = await load(cwd);
    await writeFile(
      path.join(result.artifacts.directory, "http-fixture-state.json"),
      JSON.stringify(state, null, 2),
    );
    for (const [id] of operations.filter(([id]) => id !== "implicit-file"))
      expect(getToolExecution(result, id).isError, getToolResultText(result, id)).toBe(false);
    expect(getToolExecutionDetails(getToolExecution(result, "pull-guide"))).toMatchObject({
      documentation: { kind: "document", id: "github-pulls" },
    });
    expect(getToolResultText(result, "create")).toContain(pull);
    expect(getToolResultText(result, "create")).toContain(native);
    expect(getToolResultText(result, "native")).toContain("Source: " + pull);
    expect(getToolResultText(result, "saved-body")).toContain("Edited PR body\n");
    expect(getToolResultText(result, "saved-fields")).toContain('"base": "main"');
    expect(state.pulls["12"]).toMatchObject({
      title: "Edited PR title",
      body: "Edited PR body\n",
      base: { ref: "main" },
      maintainer_can_modify: false,
    });
    for (const [created, read, source, url, body] of [
      [
        "conversation",
        "conversation-native",
        repository + "/issues/comments/101",
        native + "#issuecomment-101",
        "Conversation feedback",
      ],
      [
        "inline",
        "inline-native",
        repository + "/pulls/comments/201",
        native + "#discussion_r201",
        "Inline feedback",
      ],
      [
        "reply",
        "reply-native",
        repository + "/pulls/comments/202",
        native + "#discussion_r202",
        "Inline reply",
      ],
      [
        "pending",
        "review-native",
        pull + "/reviews/301",
        native + "#pullrequestreview-301",
        "Pending review",
      ],
    ]) {
      expect(getToolResultText(result, created)).toContain(source);
      expect(getToolResultText(result, created)).toContain(url);
      expect(getToolResultText(result, read)).toContain("Source: " + source);
      expect(getToolResultText(result, read)).toContain(body);
    }
    expect(getToolResultText(result, "reply-native")).toContain(pull + "/comments/201/replies/new");
    expect(getToolResultText(result, "conversation-body")).toContain("Conversation feedback");
    expect(getToolResultText(result, "reply-body")).toContain("Inline reply");
    expect(getToolResultText(result, "review-body")).toContain("Pending review");
    expect(state.reviews).toEqual([
      expect.objectContaining({ id: 301, state: "PENDING", ...review }),
    ]);
    expect(getToolResultText(result, "files")).toContain(patch);
    expect(getToolResultText(result, "files")).toContain(fileSource);
    expect(getToolResultText(result, "file")).toContain(fileText);
    expect(getToolExecution(result, "implicit-file").isError).toBe(true);
    expect(state.requests.filter((request) => request.method !== "GET")).toEqual([
      { method: "POST", path: "/repos/example/project/pulls", query: "", body: create },
      {
        method: "PATCH",
        path: "/repos/example/project/pulls/12",
        query: "",
        body: { body: "Edited PR body\n" },
      },
      {
        method: "PATCH",
        path: "/repos/example/project/pulls/12",
        query: "",
        body: { title: "Edited PR title", base: "main", maintainer_can_modify: false },
      },
      {
        method: "POST",
        path: "/repos/example/project/issues/12/comments",
        query: "",
        body: { body: "Conversation feedback" },
      },
      { method: "POST", path: "/repos/example/project/pulls/12/comments", query: "", body: inline },
      {
        method: "POST",
        path: "/repos/example/project/pulls/12/comments/201/replies",
        query: "",
        body: { body: "Inline reply" },
      },
      { method: "POST", path: "/repos/example/project/pulls/12/reviews", query: "", body: review },
    ]);
    expect(state.requests.filter((request) => request.path.includes("/contents/"))).toEqual([
      {
        method: "GET",
        path: "/repos/example/project/contents/src/a%20b.ts",
        query: "?ref=" + headSha,
      },
    ]);
    for (const [id] of operations)
      expect(getToolResultText(result, id)).not.toContain("private-pulls-fixture-token");
    expect(getToolResultText(result, "implicit-file")).toContain("GH_EXPLICIT_FILE_REF_REQUIRED");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);

// RPC installs a UI adapter, so use Pi's SDK with no UI binding for genuine headless evidence.
// The probe calls shared Write through ctx.executeTool, including the real tool_call approval hook.
test("headless Pi denies review submission, merge and immediate review without HTTP mutations", async () => {
  const ide = await currentIde();
  const cwd = await workspace();
  const directory = path.join(artifacts, "github-pull-headless");
  await mkdir(directory, { recursive: true });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "pulls-fixture",
    defaultModel: "headless",
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
    additionalExtensionPaths: [ide.extension, fixture],
  });
  let dispose: (() => void) | undefined;
  try {
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({ flags: { "pi-agent-ide-yolo": false, "pi-agent-github-yolo": false } }),
    );
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd,
      agentDir: path.join(cwd, "agent"),
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: ["write", "verify_pull_headless"],
    });
    dispose = () => session.dispose();
    await session.bindExtensions({ mode: "print" });
    const sessionEvents: unknown[] = [];
    session.subscribe((event) => {
      sessionEvents.push(event);
    });
    const model = session.modelRuntime.getModel("pulls-fixture", "headless");
    if (!model) throw new Error("Local scripted PR model was not registered");
    await session.setModel(model, { persist: false });
    expect(session.model?.provider).toBe("pulls-fixture");
    await session.prompt("Verify headless PR approval through shared Write.");
    const result = session.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "headless-probe",
    );
    if (!result || result.role !== "toolResult")
      throw new Error("Headless Pi did not execute its scripted probe");
    expect(result.isError).toBe(false);
    await ide.record(directory);
    await writeFile(path.join(directory, "tool-result.json"), JSON.stringify(result, null, 2));
    await writeFile(
      path.join(directory, "session-events.json"),
      JSON.stringify(sessionEvents, null, 2),
    );
    const state = await load(cwd);
    await writeFile(
      path.join(directory, "http-fixture-state.json"),
      JSON.stringify(state, null, 2),
    );
    const details = result.details as {
      hasUI: boolean;
      mode: string;
      calls: { source: string; isError: boolean; result: unknown }[];
    };
    expect(details).toMatchObject({ hasUI: false, mode: "print" });
    expect(details.calls.map((call) => call.source)).toEqual([
      pull + "/reviews/301/submit",
      pull + "/merge",
      pull + "/reviews/new",
    ]);
    for (const call of details.calls) {
      expect(call.isError).toBe(true);
      expect(JSON.stringify(call.result)).toContain("GH_APPROVAL_REQUIRED");
    }
    expect(state.requests).toEqual([]);
    expect(state.pulls["12"].state).toBe("open");
    expect(state.reviews).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("private-pulls-fixture-token");
  } finally {
    dispose?.();
    await rm(cwd, { recursive: true, force: true });
  }
}, 120_000);

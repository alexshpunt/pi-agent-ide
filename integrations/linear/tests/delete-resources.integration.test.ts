import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";
import { deleteTuiSteps, type DeleteProbeDetails } from "./fixtures/delete-resources-probe.ts";
import {
  deleteApproved,
  deleteIds,
  deleteSource,
  initialDeleteState,
  type DeleteFixtureState,
} from "./fixtures/delete-resources-state.ts";

import { linearPackageRoot as root } from "#linear-tests/fixtures/package-root.ts";
const linear = path.join(root, "src/index.ts");
const probe = path.join(root, "tests/fixtures/delete-resources-probe.ts");
const artifacts = testArtifactsDir(import.meta.filename);
async function workspace(standalone = false) {
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "linear-typed-delete-"));
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/linear.json"),
    JSON.stringify({ axiPath: path.join(root, "tests/fixtures/delete-resources-axi.mjs") }),
  );
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({
      flags: {
        "pi-agent-ide-yolo": standalone,
        "pi-agent-linear-yolo": standalone,
      },
    }),
  );
  await writeFile(path.join(cwd, "delete-fixture.json"), JSON.stringify(initialDeleteState()));
  return cwd;
}
const load = async (cwd: string): Promise<DeleteFixtureState> =>
  JSON.parse(await readFile(path.join(cwd, "delete-fixture.json"), "utf8")) as DeleteFixtureState;
const mutationRequests = (state: DeleteFixtureState) =>
  state.requests.filter((row) =>
    /\b(?:agentSkillDelete|templateDelete|documentDelete)\s*\(/u.test(row.query),
  );
function deletionReceipt(details: unknown, standalone: boolean): unknown {
  return standalone
    ? details
    : (details as { metadata?: { semanticAction?: unknown } } | undefined)?.metadata
        ?.semanticAction;
}
function headlessCalls(value: unknown) {
  if (!value || typeof value !== "object" || !("calls" in value) || !Array.isArray(value.calls)) {
    throw new Error("Headless probe did not return its call records");
  }
  return value.calls.map((call: unknown) => {
    if (
      !call ||
      typeof call !== "object" ||
      !("path" in call) ||
      typeof call.path !== "string" ||
      !("isError" in call) ||
      typeof call.isError !== "boolean" ||
      !("result" in call)
    ) {
      throw new Error("Malformed headless call record");
    }
    return { path: call.path, isError: call.isError, result: call.result };
  });
}
async function record(cwd: string, directory: string, state: DeleteFixtureState) {
  await writeFile(
    path.join(directory, "delete-fixture-state.json"),
    JSON.stringify(state, null, 2),
  );
  for (const file of [
    "delete-decisions.json",
    "delete-axi-calls.jsonl",
    "delete-headless-calls.json",
  ]) {
    const bytes = await readFile(path.join(cwd, file)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    await writeFile(path.join(directory, file), bytes);
  }
}

// These top-level ordinary calls exercise real public renderers as well as the native HTTP client.
test.each(["ide-first", "linear-first", "standalone"] as const)(
  "ordinary Delete changes only approved document, shared skill and template targets (%s)",
  async (order) => {
    const ide = await currentIde();
    const standalone = order === "standalone";
    const cwd = await workspace(standalone);
    try {
      const result = await new PiIntegrationTest({
        testName: "linear-typed-delete-" + order,
        artifactsDir: artifacts,
        cwd,
        extensions: standalone
          ? ["builtin:tool-search", probe, linear]
          : order === "linear-first"
            ? [probe, linear, ide.extension]
            : [ide.extension, probe, linear],
        isolateUserResources: true,
        rawMode: false,
        tools: [
          ...(standalone ? ["tool_search"] : ["read", "delete"]),
          "verify_linear_delete_state",
        ],
        timeoutMs: 110000,
        providerMode: "user",
        model: "linear-delete-fixture/tui",
      }).run(
        "Delete only the explicitly approved isolated fixture UUIDs. Refuse other targets, cancel one dialog, preserve non-targets, and inspect an unknown outcome without retrying it.",
      );
      await ide.record(result.artifacts.directory);
      const state = await load(cwd);
      await record(cwd, result.artifacts.directory, state);
      const failed = new Set([
        "refused",
        "cancelled",
        "body-refused",
        "creation-refused",
        "collection-refused",
        "stale-result",
        "foreign",
        "missing",
        "unknown",
      ]);
      for (const [id] of deleteTuiSteps)
        expect(
          !!getToolExecution(result, id).isError,
          id + ": " + getToolResultText(result, id),
        ).toBe(failed.has(id));
      if (standalone) expect(getToolExecution(result, "discover").isError).toBe(false);
      for (const [call, kind, id] of [
        ["document-actions", "document", deleteIds.document],
        ["skill-actions", "workflow-skill", deleteIds.skill],
        ["template-actions", "workflow-template", deleteIds.documentTemplate],
        ["alias-actions", "template", deleteIds.templateAlias],
      ]) {
        const text = getToolResultText(result, call);
        const start = text.indexOf("{");
        const end = text.indexOf("\n}", start);
        if (start < 0 || end < start) throw new Error("The action schema JSON was not returned");
        // Read may append lazy guide text after the pretty-printed JSON resource.
        const schema = JSON.parse(text.slice(start, end + 2)) as { actions: unknown };
        expect(schema.actions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source: deleteSource(kind, id),
              tool: "delete",
              approvalRequired: true,
            }),
          ]),
        );
      }
      for (const [index, [kind, id]] of deleteApproved.entries()) {
        expect(
          deletionReceipt(
            getToolExecutionDetails(getToolExecution(result, "approved-" + index)),
            standalone,
          ),
        ).toMatchObject({
          kind: "file-operation",
          operation: "delete",
          path: deleteSource(kind, id),
          ok: true,
          effect: "applied",
        });
      }
      expect(
        deletionReceipt(getToolExecutionDetails(getToolExecution(result, "unknown")), standalone),
      ).toMatchObject({
        kind: "file-operation",
        operation: "delete",
        path: deleteSource("document", deleteIds.unknown),
        ok: false,
        effect: "unknown",
        error: { code: "LINEAR_OPERATION_BACKEND_REJECTED" },
      });
      for (const id of ["foreign", "missing"])
        expect(
          deletionReceipt(getToolExecutionDetails(getToolExecution(result, id)), standalone),
        ).toMatchObject({ ok: false, effect: "not-applied" });
      expect(state.mutations).toEqual([
        { field: "documentDelete", id: deleteIds.document },
        { field: "agentSkillDelete", id: deleteIds.skill },
        { field: "templateDelete", id: deleteIds.issueTemplate },
        { field: "templateDelete", id: deleteIds.documentTemplate },
        { field: "templateDelete", id: deleteIds.templateAlias },
        { field: "documentDelete", id: deleteIds.unknown },
      ]);
      expect(mutationRequests(state)).toHaveLength(6);
      expect(
        mutationRequests(state).filter((row) => row.variables.id === deleteIds.unknown),
      ).toHaveLength(1);
      expect(state.invokes).toEqual([
        {
          workspace: "other",
          operation: "delete_workflow_template",
          input: { id: deleteIds.foreign },
        },
        { workspace: "example", operation: "delete_document", input: { id: deleteIds.missing } },
        ...deleteApproved.map(([, id, operation]) => ({
          workspace: "example",
          operation,
          input: { id },
        })),
        { workspace: "example", operation: "delete_document", input: { id: deleteIds.unknown } },
      ]);
      for (const id of [deleteIds.document, deleteIds.unknown]) {
        expect(state.resources[id]).toMatchObject({
          deleted: false,
          trashed: true,
        });
        expect(typeof state.resources[id].archivedAt).toBe("string");
      }
      for (const id of [
        deleteIds.skill,
        deleteIds.issueTemplate,
        deleteIds.documentTemplate,
        deleteIds.templateAlias,
      ])
        expect(state.resources[id]).toMatchObject({ deleted: true, trashed: false });
      const initial = initialDeleteState();
      for (const id of [
        deleteIds.refused,
        deleteIds.cancelled,
        deleteIds.preserved,
        deleteIds.foreign,
      ])
        expect(state.resources[id]).toEqual(initial.resources[id]);
      const details = getToolExecutionDetails(
        getToolExecution(result, "state"),
      ) as DeleteProbeDetails;
      expect(details).toMatchObject({ hasUI: true, mode: "tui", remembered: standalone });
      expect(
        details.decisions.find((row) => row.source === deleteSource("document", deleteIds.refused)),
      ).toMatchObject({ answer: "deny" });
      expect(
        details.decisions.find(
          (row) => row.source === deleteSource("workflow-skill", deleteIds.cancelled),
        ),
      ).toMatchObject({ answer: "cancel" });
      for (const [kind, id] of deleteApproved)
        expect(
          details.decisions.filter((row) => row.source === deleteSource(kind, id)),
        ).toMatchObject([{ answer: "allow" }]);
      expect(
        details.decisions.every(
          (row) =>
            row.hasUI &&
            row.waiting &&
            row.before === row.after &&
            row.channel === (standalone ? "confirm" : "select"),
        ),
      ).toBe(true);
      expect(result.tuiRenderedOutput).toContain(deleteIds.unknown);
      expect(result.tuiRenderedOutput).not.toContain("private-delete-fixture-token");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  140000,
);

// RPC has UI bindings; only a real print-mode SDK session proves denial without a dialog.
test("genuine headless Pi refuses all typed Delete targets before backend dispatch", async () => {
  const ide = await currentIde();
  const cwd = await workspace();
  const directory = path.join(artifacts, "linear-typed-delete-headless");
  await mkdir(directory, { recursive: true });
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: "linear-delete-fixture",
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
    additionalExtensionPaths: [ide.extension, probe, linear],
  });
  let dispose: (() => void) | undefined;
  try {
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd,
      agentDir: path.join(cwd, "agent"),
      settingsManager,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: ["delete", "verify_linear_delete_headless"],
    });
    dispose = () => session.dispose();
    await session.bindExtensions({ mode: "print" });
    const events: unknown[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    const model = session.modelRuntime.getModel("linear-delete-fixture", "headless");
    if (!model) throw new Error("Controlled Delete model was not registered");
    await session.setModel(model, { persist: false });
    await session.prompt(
      "Try only the isolated fixture typed Delete targets without UI; do not grant unattended permission.",
    );
    const result = session.messages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "headless-delete",
    );
    if (!result || result.role !== "toolResult")
      throw new Error("Headless Delete probe did not run");
    await ide.record(directory);
    await writeFile(path.join(directory, "session-events.json"), JSON.stringify(events, null, 2));
    await writeFile(path.join(directory, "tool-result.json"), JSON.stringify(result, null, 2));
    const state = await load(cwd);
    await record(cwd, directory, state);
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const details = result.details;
    const calls = headlessCalls(details);
    expect(details).toMatchObject({
      hasUI: false,
      mode: "print",
      decisions: [],
      remembered: false,
    });
    expect(calls.map((call) => call.path)).toEqual(
      deleteApproved.map(([kind, id]) => deleteSource(kind, id)),
    );
    for (const call of calls) {
      expect(call.isError).toBe(true);
      expect(JSON.stringify(call.result)).toContain("LINEAR_CONFIRMATION_REQUIRED");
    }
    expect(state).toEqual(initialDeleteState());
  } finally {
    dispose?.();
    await rm(cwd, { recursive: true, force: true });
  }
}, 140000);

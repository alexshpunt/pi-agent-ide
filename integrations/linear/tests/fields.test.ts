import { ResourceError } from "pi-agent-ide/api/resource";
import { expect, test, vi } from "vitest";
import { createLinearFields, parseLinearFieldAddress } from "#linear/fields.ts";
import type { LinearOperationBackend, LinearOperationReceipt } from "#linear/operation-backend.ts";

const issue = "https://linear.app/example/issue/ENG-12/fixture";
const saveSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    state: { type: "string" },
    labels: { type: "array", items: { type: "string" } },
    priority: { type: "number" },
  },
  additionalProperties: false,
};
function fixture() {
  let current = {
    id: "ENG-12",
    title: "Unchanged",
    description: "Body",
    status: "Todo",
    labels: ["Bug"],
    priority: 3,
  };
  const invoke = vi.fn(
    async (
      _workspace: string,
      operation: string,
      input: Readonly<Record<string, unknown>>,
    ): Promise<LinearOperationReceipt> => {
      if (operation === "save_issue")
        current = {
          ...current,
          ...(input.state === undefined ? {} : { status: input.state as string }),
          ...(input.labels === undefined ? {} : { labels: input.labels as string[] }),
          ...(input.priority === undefined ? {} : { priority: input.priority as number }),
        };
      return { workspace: "example", operation, effect: "applied", data: { ...current } };
    },
  );
  const backend: LinearOperationBackend = {
    capabilities: async () => [
      { name: "save_issue", inputSchema: saveSchema, annotations: {} },
      {
        name: "get_issue",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        annotations: { readOnlyHint: true },
      },
    ],
    invoke,
  };
  return { backend, invoke, current: () => current };
}

test("native field identities preserve workspace, object and fragment", () => {
  expect(parseLinearFieldAddress(`${issue}#status`)).toMatchObject({
    workspace: "example",
    kind: "issue",
    id: "ENG-12",
    facet: "status",
  });
  expect(parseLinearFieldAddress("https://example.org/page#status")).toBeUndefined();
});

test("Write on #status updates only the typed field", async () => {
  const f = fixture();
  const fields = createLinearFields(f.backend);
  expect(await fields.read(`${issue}#status`, process.cwd())).toBe("Todo");
  expect(await fields.write(`${issue}#status`, "In Progress", process.cwd())).toMatchObject({
    effect: "applied",
  });
  expect(f.current()).toMatchObject({
    status: "In Progress",
    title: "Unchanged",
    description: "Body",
    labels: ["Bug"],
  });
  expect(f.invoke.mock.calls.filter(([, operation]) => operation === "save_issue")).toHaveLength(1);
});

test.each(["status", "delegate"])(
  "a scalar %s read requests its projection on the first call",
  async (field) => {
    const f = fixture();
    const original = f.backend.capabilities;
    f.backend.capabilities = async (...args) =>
      (await original(...args)).map((cap) => ({
        ...cap,
        inputSchema: {
          ...cap.inputSchema,
          properties: {
            ...(cap.inputSchema.properties as Record<string, unknown>),
            ...(cap.name === "get_issue"
              ? { fields: { type: "array", items: { enum: ["status", "delegate"] } } }
              : {}),
            ...(cap.name === "save_issue" ? { delegate: { type: ["string", "null"] } } : {}),
          },
        },
      }));
    const invoke = f.backend.invoke;
    f.backend.invoke = vi.fn<LinearOperationBackend["invoke"]>(async (...args) => {
      const result = await invoke(...args);
      return field === "delegate" && Array.isArray(args[2].fields)
        ? { ...result, data: { ...(result.data as Record<string, unknown>), delegate: null } }
        : result;
    });
    const value = await createLinearFields(f.backend).read(`${issue}#${field}`, process.cwd());
    expect(value).toBe(field === "status" ? "Todo" : "null");
    expect(
      vi.mocked(f.backend.invoke).mock.calls.map(([, operation, input]) => ({ operation, input })),
    ).toEqual([{ operation: "get_issue", input: { id: "ENG-12", fields: [field] } }]);
  },
);
test("a projected Read cannot replace the full pre-save state of a later edit", async () => {
  const f = fixture();
  const original = f.backend.capabilities;
  f.backend.capabilities = async (...args) =>
    (await original(...args)).map((cap) =>
      cap.name === "get_issue"
        ? {
            ...cap,
            inputSchema: {
              ...cap.inputSchema,
              properties: {
                ...(cap.inputSchema.properties as Record<string, unknown>),
                fields: { type: "array", items: { enum: ["status"] } },
              },
            },
          }
        : cap,
    );
  const result = await createLinearFields(f.backend).resolver.tryResolve(`${issue}#status`, {
    cwd: process.cwd(),
  });
  if (result.kind !== "resolved" || !result.resource.write)
    throw new Error("Expected writable field");
  await result.resource.write([{ type: "text", text: "Done" }], {});
  expect(f.current().status).toBe("Done");
  expect(
    f.invoke.mock.calls
      .filter(([, operation]) => operation === "get_issue")
      .map(([, , input]) => input),
  ).toEqual([{ id: "ENG-12", fields: ["status"] }, { id: "ENG-12" }]);
  expect(f.invoke.mock.calls.filter(([, operation]) => operation === "save_issue")).toHaveLength(1);
});
test("labels are a typed set; appending preserves current members", async () => {
  const f = fixture();
  const fields = createLinearFields(f.backend);
  await fields.write(`${issue}#labels`, "Bug\nUrgent", process.cwd());
  expect(f.current().labels).toEqual(["Bug", "Urgent"]);
});

test("an invalid scalar is rejected before a save", async () => {
  const f = fixture();
  const fields = createLinearFields(f.backend);
  await expect(
    fields.write(`${issue}#priority`, "not-a-number", process.cwd()),
  ).rejects.toMatchObject({ effect: "not-applied" });
  expect(f.invoke.mock.calls.some(([, operation]) => operation === "save_issue")).toBe(false);
});

test("a URL identity cannot be replaced by an id inside a creation/action payload", async () => {
  const f = fixture();
  await expect(
    createLinearFields(f.backend).write(
      `${issue}#fields`,
      '{"id":"ENG-99","state":"Done"}',
      process.cwd(),
    ),
  ).rejects.toMatchObject({ effect: "not-applied" });
  expect(f.invoke.mock.calls.some(([, operation]) => operation === "save_issue")).toBe(false);
});

test("unknown outcomes are not replayed and cannot become successful field edits", async () => {
  const f = fixture();
  const original = f.backend.invoke;
  f.backend.invoke = vi.fn<LinearOperationBackend["invoke"]>(
    async (workspace, operation, input, cwd, signal): Promise<LinearOperationReceipt> =>
      operation === "save_issue"
        ? { workspace, operation, effect: "unknown", error: "LINEAR_RESOURCE_FAILED" }
        : original(workspace, operation, input, cwd, signal),
  );
  await expect(
    createLinearFields(f.backend).write(`${issue}#status`, "Done", process.cwd()),
  ).rejects.toMatchObject({ effect: "unknown" });
  expect(f.invoke.mock.calls.filter(([, operation]) => operation === "save_issue")).toHaveLength(0);
  expect(
    vi.mocked(f.backend.invoke).mock.calls.filter(([, operation]) => operation === "save_issue"),
  ).toHaveLength(1);
});

test.each(["receipt", "process"] as const)(
  "an unknown save (%s) whose readback already shows every requested value is applied",
  async (failure) => {
    const f = fixture();
    const original = f.backend.invoke;
    f.backend.invoke = vi.fn<LinearOperationBackend["invoke"]>(
      async (workspace, operation, input, cwd, signal): Promise<LinearOperationReceipt> => {
        const result = await original(workspace, operation, input, cwd, signal);
        if (operation !== "save_issue") return result;
        // Linear applied the save, but its response never arrived.
        if (failure === "process")
          throw new ResourceError("LINEAR_AXI_TIMEOUT", `linear://${workspace}`, "unknown");
        return { workspace, operation, effect: "unknown", error: "LINEAR_OPERATION_TIMEOUT" };
      },
    );
    const fields = createLinearFields(f.backend);
    expect(await fields.write(`${issue}#status`, "Done", process.cwd())).toMatchObject({
      effect: "applied",
    });
    expect(
      await fields.write(`${issue}#fields`, '{"state":"In Review","priority":1}', process.cwd()),
    ).toMatchObject({ effect: "applied" });
    expect(f.current()).toMatchObject({ status: "In Review", priority: 1 });
    expect(f.invoke.mock.calls.filter(([, operation]) => operation === "save_issue")).toHaveLength(
      2,
    );
  },
);

test("an unknown save stays unknown when the readback shows only some requested values", async () => {
  const f = fixture();
  const original = f.backend.invoke;
  f.backend.invoke = vi.fn<LinearOperationBackend["invoke"]>(
    async (workspace, operation, input, cwd, signal): Promise<LinearOperationReceipt> =>
      operation === "save_issue"
        ? (await original(workspace, operation, { ...input, priority: undefined }, cwd, signal),
          { workspace, operation, effect: "unknown", error: "LINEAR_OPERATION_TIMEOUT" })
        : original(workspace, operation, input, cwd, signal),
  );
  await expect(
    createLinearFields(f.backend).write(
      `${issue}#fields`,
      '{"state":"Done","priority":1}',
      process.cwd(),
    ),
  ).rejects.toMatchObject({ code: "LINEAR_OPERATION_TIMEOUT", effect: "unknown" });
  expect(f.current()).toMatchObject({ status: "Done", priority: 3 });
});

test("a remote rejection remains not applied and is never replayed", async () => {
  const f = fixture();
  const original = f.backend.invoke;
  f.backend.invoke = vi.fn<LinearOperationBackend["invoke"]>(
    async (workspace, operation, input, cwd, signal): Promise<LinearOperationReceipt> =>
      operation === "save_issue"
        ? { workspace, operation, effect: "not-applied", error: "LINEAR_PERMISSION_DENIED" }
        : original(workspace, operation, input, cwd, signal),
  );
  await expect(
    createLinearFields(f.backend).write(`${issue}#status`, "Done", process.cwd()),
  ).rejects.toMatchObject({ code: "LINEAR_PERMISSION_DENIED", effect: "not-applied" });
  expect(vi.mocked(f.backend.invoke).mock.calls.map(([, operation]) => operation)).toEqual([
    "get_issue",
    "save_issue",
  ]);
});

test("a confirmed full fields save does not compare immediate readback", async () => {
  const f = fixture();
  const original = f.backend.invoke;
  f.backend.invoke = vi.fn<LinearOperationBackend["invoke"]>(
    async (workspace, operation, input, cwd, signal): Promise<LinearOperationReceipt> =>
      operation === "save_issue"
        ? { workspace, operation, effect: "applied", data: f.current() }
        : original(workspace, operation, input, cwd, signal),
  );
  await expect(
    createLinearFields(f.backend).write(`${issue}#fields`, '{"state":"Done"}', process.cwd()),
  ).resolves.toMatchObject({ effect: "applied" });
  expect(f.current().status).toBe("Todo");
  expect(vi.mocked(f.backend.invoke).mock.calls.map(([, operation]) => operation)).toEqual([
    "get_issue",
    "save_issue",
  ]);
});

test("a confirmed field save does not depend on an available immediate readback", async () => {
  const f = fixture();
  const original = f.backend.invoke;
  let saved = false;
  f.backend.invoke = vi.fn<LinearOperationBackend["invoke"]>(
    async (workspace, operation, input, cwd, signal) => {
      if (operation === "get_issue" && saved) throw new Error("LINEAR_AXI_FAILED");
      const receipt = await original(workspace, operation, input, cwd, signal);
      if (operation === "save_issue") saved = true;
      return receipt;
    },
  );
  const fields = createLinearFields(f.backend);
  await expect(fields.write(`${issue}#status`, "Done", process.cwd())).resolves.toMatchObject({
    effect: "applied",
  });
  await expect(fields.read(`${issue}#status`, process.cwd())).rejects.toThrow("LINEAR_AXI_FAILED");
  expect(
    vi.mocked(f.backend.invoke).mock.calls.filter(([, operation]) => operation === "save_issue"),
  ).toHaveLength(1);
});

test("a field resource uses the saved representation from the save response before its next edit", async () => {
  const f = fixture();
  const original = f.backend.invoke;
  f.backend.invoke = vi.fn<LinearOperationBackend["invoke"]>(
    (workspace, operation, input, cwd, signal) =>
      original(
        workspace,
        operation,
        operation === "save_issue" ? { ...input, state: "Server state" } : input,
        cwd,
        signal,
      ),
  );
  const result = await createLinearFields(f.backend).resolver.tryResolve(`${issue}#status`, {
    cwd: process.cwd(),
  });
  if (result.kind !== "resolved" || !result.resource.write || !result.resource.read)
    throw new Error("Expected a writable field");
  await result.resource.write([{ type: "text", text: "Requested state" }], {});
  expect(result.resource.sourceBytes && Buffer.from(result.resource.sourceBytes).toString()).toBe(
    "Server state",
  );
  await expect(result.resource.read({})).resolves.toEqual([{ type: "text", text: "Server state" }]);
  const calls = () => vi.mocked(f.backend.invoke).mock.calls.map(([, operation]) => operation);
  // One card read serves both the Read snapshot and the pre-save state; the save response
  // serves the readback.
  expect(calls()).toEqual(["get_issue", "save_issue"]);
  await expect(
    result.resource.write([{ type: "text", text: "Next state" }], {}),
  ).resolves.toBeUndefined();
  // A later write on the same resource reads a fresh pre-save card.
  expect(calls()).toEqual(["get_issue", "save_issue", "get_issue", "save_issue"]);
});

test("a field resource keeps a confirmed save separate from failed later reads", async () => {
  const f = fixture();
  const original = f.backend.invoke;
  let saved = false;
  f.backend.invoke = vi.fn<LinearOperationBackend["invoke"]>(
    async (workspace, operation, input, cwd, signal) => {
      if (operation === "get_issue" && saved) throw new Error("LINEAR_AXI_FAILED");
      const receipt = await original(workspace, operation, input, cwd, signal);
      if (operation !== "save_issue") return receipt;
      saved = true;
      // A save response without the issue row leaves the readback to a later request.
      return { ...receipt, data: { success: true } };
    },
  );
  const result = await createLinearFields(f.backend).resolver.tryResolve(`${issue}#status`, {
    cwd: process.cwd(),
  });
  if (result.kind !== "resolved" || !result.resource.write || !result.resource.read)
    throw new Error("Expected a writable field");
  await expect(
    result.resource.write([{ type: "text", text: "Done" }], {}),
  ).resolves.toBeUndefined();
  expect(result.resource.sourceBytes).toBeUndefined();
  await expect(result.resource.read({})).rejects.toMatchObject({
    code: "LINEAR_READBACK_UNAVAILABLE",
    effect: "applied",
  });
  expect(
    vi.mocked(f.backend.invoke).mock.calls.filter(([, operation]) => operation === "save_issue"),
  ).toHaveLength(1);
});

test("a UUID field resource refuses a different returned project before mutation", async () => {
  const backend: LinearOperationBackend = {
    capabilities: async () => [
      {
        name: "get_project",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        annotations: {},
      },
      {
        name: "save_project",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, state: { type: "string" } },
        },
        annotations: {},
      },
    ],
    invoke: vi.fn<LinearOperationBackend["invoke"]>(
      async (workspace, operation): Promise<LinearOperationReceipt> => ({
        workspace,
        operation,
        effect: "applied",
        data: {
          id: "22222222-2222-4222-8222-222222222222",
          url: "https://linear.app/example/project/wrong-123456789abc",
          status: "Todo",
        },
      }),
    ),
  };
  await expect(
    createLinearFields(backend).write(
      "linear://example/project/11111111-1111-4111-8111-111111111111#status",
      "Done",
      process.cwd(),
    ),
  ).rejects.toMatchObject({ code: "LINEAR_IDENTITY_MISMATCH", effect: "not-applied" });
  expect(
    vi.mocked(backend.invoke).mock.calls.some(([, operation]) => operation === "save_project"),
  ).toBe(false);
});

const aliceId = "11111111-1111-4111-8111-111111111111";
const bobId = "22222222-2222-4222-8222-222222222222";
const bugId = "33333333-3333-4333-8333-333333333333";
const featureId = "44444444-4444-4444-8444-444444444444";

function metadataFixture(options: { exposeEstimate?: boolean; ignoreSave?: boolean } = {}) {
  let current: Record<string, unknown> = {
    id: "ENG-12",
    title: "Unchanged",
    description: "Body",
    teamId: "team-1",
    status: "Triage",
    labels: ["Bug"],
    priority: { value: 0, name: "No priority" },
    assignee: "Alice",
    assigneeId: aliceId,
    ...(options.exposeEstimate === false ? {} : { estimate: null }),
  };
  const labelNames: Record<string, string> = { [bugId]: "Bug", [featureId]: "Feature" };
  const invoke = vi.fn(
    async (
      workspace: string,
      operation: string,
      input: Readonly<Record<string, unknown>>,
    ): Promise<LinearOperationReceipt> => {
      if (operation === "get_user") {
        const bob = input.query === "Bob" || input.query === bobId;
        return {
          workspace,
          operation,
          effect: "applied",
          data: { id: bob ? bobId : aliceId, name: bob ? "Bob" : "Alice" },
        };
      }
      if (operation === "list_issue_labels")
        return {
          workspace,
          operation,
          effect: "applied",
          data: {
            labels: [
              { id: bugId, name: "Bug" },
              { id: featureId, name: "Feature" },
            ],
            hasNextPage: false,
          },
        };
      if (operation === "save_issue" && !options.ignoreSave) {
        current = { ...current };
        if (input.priority !== undefined) current.priority = { value: input.priority };
        if (Object.hasOwn(input, "assignee")) {
          if (input.assignee === null) {
            delete current.assignee;
            delete current.assigneeId;
          } else {
            const bob = input.assignee === "Bob" || input.assignee === bobId;
            current.assignee = bob ? "Bob" : "Alice";
            current.assigneeId = bob ? bobId : aliceId;
          }
        }
        if (Object.hasOwn(input, "estimate") && options.exposeEstimate !== false)
          current.estimate = input.estimate;
        if (Array.isArray(input.labels))
          current.labels = input.labels.map((label) => labelNames[String(label)] ?? label);
        if (Array.isArray(input.addLabels))
          current.labels = [
            ...new Set([
              ...(current.labels as string[]),
              ...input.addLabels.map((label) => labelNames[String(label)] ?? String(label)),
            ]),
          ];
        if (Array.isArray(input.removeLabels)) {
          const removals = new Set(
            input.removeLabels.map((label) => labelNames[String(label)] ?? String(label)),
          );
          current.labels = (current.labels as string[]).filter((label) => !removals.has(label));
        }
      }
      return { workspace, operation, effect: "applied", data: { ...current } };
    },
  );
  const backend: LinearOperationBackend = {
    capabilities: async () => [
      {
        name: "save_issue",
        inputSchema: {
          ...saveSchema,
          properties: {
            ...saveSchema.properties,
            assignee: { type: ["string", "null"] },
            estimate: { type: ["number", "null"] },
            addLabels: { type: "array", items: { type: "string" } },
            removeLabels: { type: "array", items: { type: "string" } },
          },
        },
        annotations: {},
      },
      {
        name: "get_issue",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        annotations: {},
      },
      {
        name: "get_user",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        annotations: {},
      },
      {
        name: "list_issue_labels",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", maximum: 250 },
            team: { type: "string" },
          },
        },
        annotations: {},
      },
    ],
    invoke,
  };
  return { backend, invoke, current: () => current };
}

test("metadata reads preserve zero priority, numeric estimates and an empty assignee", async () => {
  const f = metadataFixture();
  const fields = createLinearFields(f.backend);
  expect(await fields.read(`${issue}#priority`, process.cwd())).toBe("0");
  expect(await fields.read(`${issue}#estimate`, process.cwd())).toBe("null");
  await fields.write(`${issue}#estimate`, "0", process.cwd());
  expect(await fields.read(`${issue}#estimate`, process.cwd())).toBe("0");
  await fields.write(`${issue}#assignee`, "null", process.cwd());
  expect(await fields.read(`${issue}#assignee`, process.cwd())).toBe("null");
  expect(f.current().status).toBe("Triage");
});

test.each([aliceId, "me", "alice@example.com"])(
  "assignee %s resolves to the intended identity before save",
  async (assignee) => {
    const f = metadataFixture();
    const fields = createLinearFields(f.backend);
    await expect(fields.write(`${issue}#assignee`, assignee, process.cwd())).resolves.toMatchObject(
      { effect: "applied" },
    );
    expect(await fields.read(`${issue}#assignee`, process.cwd())).toBe("Alice");
    expect(f.invoke.mock.calls.filter(([, operation]) => operation === "save_issue")).toHaveLength(
      1,
    );
  },
);

test("a full metadata update preserves assignee, label and numeric field semantics", async () => {
  const f = metadataFixture();
  const fields = createLinearFields(f.backend);
  await expect(
    fields.write(
      `${issue}#fields`,
      JSON.stringify({
        priority: 3,
        assignee: bobId,
        estimate: 2,
        labels: [bugId, featureId],
      }),
      process.cwd(),
    ),
  ).resolves.toMatchObject({ effect: "applied" });
  expect(f.current()).toMatchObject({
    assignee: "Bob",
    assigneeId: bobId,
    estimate: 2,
    labels: ["Bug", "Feature"],
    priority: { value: 3 },
    status: "Triage",
    title: "Unchanged",
    description: "Body",
  });
});

test("addLabels and removeLabels preserve other labels", async () => {
  const f = metadataFixture();
  const fields = createLinearFields(f.backend);
  await expect(
    fields.write(`${issue}#fields`, JSON.stringify({ addLabels: [featureId] }), process.cwd()),
  ).resolves.toMatchObject({ effect: "applied" });
  expect(f.current().labels).toEqual(["Bug", "Feature"]);
  await expect(
    fields.write(`${issue}#fields`, JSON.stringify({ removeLabels: [bugId] }), process.cwd()),
  ).resolves.toMatchObject({ effect: "applied" });
  expect(f.current().labels).toEqual(["Feature"]);
});

test("confirmed assignee and label writes do not require matching immediate readback", async () => {
  const f = metadataFixture({ ignoreSave: true });
  const fields = createLinearFields(f.backend);
  await expect(fields.write(`${issue}#assignee`, bobId, process.cwd())).resolves.toMatchObject({
    effect: "applied",
  });
  await expect(
    fields.write(`${issue}#labels`, JSON.stringify([featureId]), process.cwd()),
  ).resolves.toMatchObject({ effect: "applied" });
  expect(f.invoke.mock.calls.filter(([, operation]) => operation === "save_issue")).toHaveLength(2);
});

test("confirmed estimate writes do not require readback to expose the field", async () => {
  const f = metadataFixture({ exposeEstimate: false });
  const fields = createLinearFields(f.backend);
  await expect(fields.read(`${issue}#estimate`, process.cwd())).rejects.toThrow(
    "LINEAR_FIELD_NOT_EXPOSED",
  );
  for (const estimate of [2, null])
    await expect(
      fields.write(`${issue}#fields`, JSON.stringify({ estimate }), process.cwd()),
    ).resolves.toMatchObject({ effect: "applied" });
  expect(f.invoke.mock.calls.filter(([, operation]) => operation === "save_issue")).toHaveLength(2);
});

test("an unavailable estimate field resolves as an explicit metadata error, not a text anchor", async () => {
  const f = metadataFixture({ exposeEstimate: false });
  const result = await createLinearFields(f.backend).resolver.tryResolve(`${issue}#estimate`, {
    cwd: process.cwd(),
  });
  expect(result).toMatchObject({
    kind: "failed",
    error: { code: "LINEAR_FIELD_NOT_EXPOSED", effect: "not-applied" },
  });
});

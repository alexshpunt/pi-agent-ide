import { expect, test, vi } from "vitest";
import { createCustomerRequestBackend } from "#linear/customer-requests.ts";
import { readLinearDomain } from "#linear/domain-read.ts";
import { createLinearFields } from "#linear/fields.ts";
import { createLinearOperationHandlers } from "#linear/operation-actions.ts";
import type { LinearOperationBackend, LinearOperationReceipt } from "#linear/operation-backend.ts";

const project = "11111111-1111-4111-8111-111111111111";
const customer = "22222222-2222-4222-8222-222222222222";
const need = "33333333-3333-4333-8333-333333333333";
const issue = "44444444-4444-4444-8444-444444444444";

function fixture(
  options: {
    paginated?: boolean;
    incomplete?: boolean;
    wrongProject?: boolean;
    unknown?: boolean;
    malformedCreate?: boolean;
  } = {},
) {
  let linked = false;
  const row = () => ({
    id: need,
    body: "Keep the original feedback",
    customer: { id: customer, name: "Customer" },
    project: { id: project, name: "Project", status: { name: "Backlog" } },
    ...(linked
      ? {
          issue: { id: "ENG-12", title: "Triage issue", state: { name: "Triage", type: "triage" } },
        }
      : {}),
    priority: 0,
  });
  const invoke = vi.fn(
    async (
      workspace: string,
      operation: string,
      input: Readonly<Record<string, unknown>>,
    ): Promise<LinearOperationReceipt> => {
      let data: unknown;
      if (operation === "get_project")
        data = {
          id: "P-ENG-1",
          uuid: project,
          name: "Project",
          url: "https://linear.app/example/project/project-123456789abc",
        };
      else if (operation === "get_issue")
        data = {
          id: "ENG-12",
          uuid: issue,
          projectId: options.wrongProject ? customer : project,
          url: "https://linear.app/example/issue/ENG-12/triage-issue",
        };
      else if (operation === "list_customer_needs")
        data =
          options.incomplete || (options.paginated && !input.cursor)
            ? {
                customerNeeds: [],
                hasNextPage: true,
                cursor: options.incomplete ? String(Number(input.cursor ?? 0) + 1) : "next",
              }
            : { customerNeeds: [row()], hasNextPage: false };
      else if (operation === "save_customer_need") {
        if (options.unknown)
          return { workspace, operation, effect: "unknown", error: "LINEAR_RESOURCE_FAILED" };
        linked = input.issue !== undefined;
        data = options.malformedCreate ? null : { id: need, body: row().body };
      } else throw new Error("Unexpected operation");
      return { workspace, operation, effect: "applied", data };
    },
  );
  const backend: LinearOperationBackend = {
    capabilities: async () => [
      {
        name: "list_customer_needs",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string" },
            cursor: { type: "string" },
            limit: { type: "number", maximum: 250 },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "save_customer_need",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            body: { type: "string" },
            project: { type: "string" },
            customer: { type: "string" },
            issue: { type: "string" },
            priority: { type: "number" },
          },
        },
        annotations: {},
      },
      {
        name: "get_project",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        annotations: {},
      },
      {
        name: "get_issue",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        annotations: {},
      },
    ],
    invoke,
  };
  return { backend, invoke };
}

test("a scoped request getter is local and follows bounded API pages to its exact identity", async () => {
  const f = fixture({ paginated: true });
  const backend = createCustomerRequestBackend(f.backend);
  expect(
    (await backend.capabilities("example", process.cwd())).some(
      (c) => c.name === "get_customer_request",
    ),
  ).toBe(true);
  const receipt = await backend.invoke(
    "example",
    "get_customer_request",
    { id: need, project },
    process.cwd(),
  );
  expect(receipt).toMatchObject({
    workspace: "example",
    operation: "get_customer_request",
    effect: "applied",
    data: { id: need, body: "Keep the original feedback", customer, project, issue: null },
  });
  expect(f.invoke.mock.calls.filter(([, op]) => op === "list_customer_needs")).toHaveLength(2);
  expect(f.invoke.mock.calls.some(([, op]) => op === "get_customer_request")).toBe(false);
});

test("linking uses the original request identity and does not send its read scope as a project move", async () => {
  const f = fixture();
  const backend = createCustomerRequestBackend(f.backend);
  await backend.invoke(
    "example",
    "save_customer_need",
    { id: need, project, issue: "ENG-12" },
    process.cwd(),
  );
  expect(f.invoke.mock.calls.filter(([, op]) => op === "save_customer_need")).toEqual([
    ["example", "save_customer_need", { id: need, issue }, process.cwd(), undefined],
  ]);
  const saved = await backend.invoke(
    "example",
    "get_customer_request",
    { id: need, project },
    process.cwd(),
  );
  expect(saved.data).toMatchObject({
    id: need,
    issue,
    body: "Keep the original feedback",
    customer,
    project,
    issueDetails: { state: { name: "Triage", type: "triage" } },
  });
});

test("an issue in another project is rejected before a request can be linked", async () => {
  const f = fixture({ wrongProject: true });
  await expect(
    createCustomerRequestBackend(f.backend).invoke(
      "example",
      "save_customer_need",
      { id: need, project, issue: "ENG-12" },
      process.cwd(),
    ),
  ).rejects.toMatchObject({ code: "LINEAR_IDENTITY_MISMATCH", effect: "not-applied" });
  expect(f.invoke.mock.calls.some(([, op]) => op === "save_customer_need")).toBe(false);
});

test("a project-linked idea is created without creating an issue and retains a readable project scope", async () => {
  const f = fixture();
  const result = await createCustomerRequestBackend(f.backend).invoke(
    "example",
    "save_customer_need",
    { body: "An idea", customer, project: "Project" },
    process.cwd(),
  );
  expect(result).toMatchObject({
    effect: "applied",
    data: { id: need, requestScopeProject: project },
  });
  expect(f.invoke.mock.calls.find(([, op]) => op === "save_customer_need")?.[2]).toEqual({
    body: "An idea",
    customer,
    project,
  });
  expect(f.invoke.mock.calls.some(([, op]) => op === "save_issue")).toBe(false);
});

test("a bounded incomplete lookup cannot become absence or dispatch a mutation", async () => {
  const f = fixture({ incomplete: true });
  await expect(
    createCustomerRequestBackend(f.backend).invoke(
      "example",
      "save_customer_need",
      { id: need, project, body: "Changed" },
      process.cwd(),
    ),
  ).rejects.toMatchObject({ code: "LINEAR_LOOKUP_INCOMPLETE", effect: "not-applied" });
  expect(f.invoke.mock.calls.filter(([, op]) => op === "list_customer_needs")).toHaveLength(5);
  expect(f.invoke.mock.calls.some(([, op]) => op === "save_customer_need")).toBe(false);
});

test("an acknowledged creation with a malformed receipt is unknown and never repeated", async () => {
  const f = fixture({ malformedCreate: true });
  await expect(
    createCustomerRequestBackend(f.backend).invoke(
      "example",
      "save_customer_need",
      { body: "An idea", customer, project },
      process.cwd(),
    ),
  ).rejects.toMatchObject({ code: "LINEAR_CREATION_RECEIPT_INVALID", effect: "unknown" });
  expect(f.invoke.mock.calls.filter(([, op]) => op === "save_customer_need")).toHaveLength(1);
});
test("an unknown save remains unknown and is never replayed", async () => {
  const f = fixture({ unknown: true });
  const result = await createCustomerRequestBackend(f.backend).invoke(
    "example",
    "save_customer_need",
    { id: need, project, body: "Changed" },
    process.cwd(),
  );
  expect(result).toMatchObject({ effect: "unknown" });
  expect(f.invoke.mock.calls.filter(([, op]) => op === "save_customer_need")).toHaveLength(1);
});

test("ordinary domain reads advertise project-scoped stable request links and readable bodies", async () => {
  const f = fixture();
  const backend = createCustomerRequestBackend(f.backend);
  const list = await readLinearDomain(
    "linear://example/customer-requests?project=Project",
    process.cwd(),
    undefined,
    backend,
  );
  const source = `linear://example/customer-request/${need}?project=${project}`;
  expect(list).toContain(source);
  expect(list).toContain("End of API list.");
  expect(await readLinearDomain(source, process.cwd(), undefined, backend)).toContain(
    "Keep the original feedback",
  );
  expect(await createLinearFields(backend).read(`${source}#body`, process.cwd())).toBe(
    "Keep the original feedback",
  );
});

test("ordinary request linking verifies issue identifiers against their canonical UUID", async () => {
  const f = fixture();
  const fields = createLinearFields(createCustomerRequestBackend(f.backend));
  const source = `linear://example/customer-request/${need}?project=${project}#issue`;
  expect(await fields.read(source, process.cwd())).toBe("null");
  await expect(fields.write(source, "ENG-12", process.cwd())).resolves.toMatchObject({
    effect: "applied",
  });
  expect(await fields.read(source, process.cwd())).toBe(issue);
});
test("ordinary Write returns a readable scoped request identity instead of the creation target", async () => {
  const f = fixture();
  const handler = createLinearOperationHandlers(
    createCustomerRequestBackend(f.backend),
    () => {},
  ).write;
  const input = {
    path: "linear://example/customer-request/new",
    content: JSON.stringify({ body: "An idea", customer, project: "Project" }),
  };
  expect(handler.matches(input)).toBe(true);
  const result = await handler.execute(
    { cwd: process.cwd(), sourceDocument: { content: "" } },
    input,
  );
  expect(result.source).toBe(`linear://example/customer-request/${need}?project=${project}`);
  expect(
    await createLinearFields(createCustomerRequestBackend(f.backend)).read(
      `${result.source}#body`,
      process.cwd(),
    ),
  ).toBe("Keep the original feedback");
  expect(f.invoke.mock.calls.filter(([, op]) => op === "save_customer_need")).toHaveLength(1);
});

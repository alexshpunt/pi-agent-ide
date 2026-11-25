import { expect, test, vi } from "vitest";
import { createLinearApi } from "#linear/api.ts";
import { createStandaloneResources } from "#linear/standalone-resources.ts";

test("a headless raw query is an owned action, not an unobserved file edit or failed mutation", async () => {
  const execute = vi.fn(async () => ({
    workspace: "example",
    operationType: "query",
    status: 200,
    effect: "not-applied",
    ok: true,
    outcome: "success",
    data: { fixture: 1 },
  }));
  const api = createLinearApi(execute);
  const host = createStandaloneResources({
    resolvers: [api.resolver],
    write: [api.write],
    insert: [],
    fileOperations: [],
    guides: [],
    ownsWriteAction: api.ownsAction,
  });
  const result = await host.mutate(
    "write",
    { path: "linear://example/api/graphql", content: '{"query":"{ fixture }"}' },
    { cwd: "/fixture" },
  );
  expect(result.isError).not.toBe(true);
  expect(result.details).toMatchObject({
    metadata: { semanticAction: { ok: true, effect: "not-applied" } },
  });
  expect(execute).toHaveBeenCalledOnce();
});

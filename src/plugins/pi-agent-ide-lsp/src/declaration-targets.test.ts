import { expect, test, vi } from "vitest";
import { createDeclarationTargets } from "./declaration-targets.js";

test("declaration text resolution leaves symbol name resources to semantic rename", async () => {
  const managerFor = vi.fn(async () => {
    throw new Error("Declaration resolution must not run for a rename resource");
  });
  const resolver = createDeclarationTargets(managerFor);
  for (const source of ["symbol:task.ts#count#name", "symbol:task.ts#Counter/count#name"]) {
    expect(await resolver.tryResolve(source, { cwd: process.cwd() })).toEqual({
      kind: "not-handled",
    });
  }
  expect(managerFor).not.toHaveBeenCalled();
});

test("a declaration that cannot resolve tells the agent why", async () => {
  const startup = "[lsp] rust-analyzer exited during startup with code 1: error: Unknown binary";
  const resolver = createDeclarationTargets(async () => {
    throw new Error(startup);
  });
  const result = await resolver.tryResolve("symbol:main.rs#run", { cwd: process.cwd() });
  expect(result).toMatchObject({ kind: "rejected", rejection: { code: "invalid" } });
  expect(result.kind === "rejected" && result.rejection.reason).toContain(startup);

  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  expect(
    await resolver.tryResolve("symbol:main.rs#run", {
      cwd: process.cwd(),
      signal: controller.signal,
    }),
  ).toMatchObject({ kind: "failed" });
});

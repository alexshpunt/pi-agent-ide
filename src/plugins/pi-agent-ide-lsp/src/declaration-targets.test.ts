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

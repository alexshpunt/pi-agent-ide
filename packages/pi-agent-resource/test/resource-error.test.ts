import { expect, test, vi } from "vitest";
import { ResourceError } from "pi-agent-resource";

test("recognizes provider failures across independently loaded SDK modules", async () => {
  vi.resetModules();
  const { ResourceError: ReloadedResourceError } = await import("pi-agent-resource");
  expect(ReloadedResourceError).not.toBe(ResourceError);
  const failure = new ReloadedResourceError(
    "PROVIDER_READBACK_UNAVAILABLE",
    "remote:body",
    "applied",
  );
  expect(failure).toBeInstanceOf(ResourceError);
  expect(new ResourceError("SAVE_REJECTED", "remote:body", "not-applied")).toBeInstanceOf(
    ReloadedResourceError,
  );
  expect(failure.code).toBe("PROVIDER_READBACK_UNAVAILABLE");
  expect(failure.effect).toBe("applied");
});

test("ordinary exceptions and lookalike objects are not trusted provider failures", () => {
  expect(new Error("PRIVATE_BACKEND_BODY")).not.toBeInstanceOf(ResourceError);
  expect({
    name: "ResourceError",
    code: "SECRET",
    source: "remote:body",
    effect: "applied",
  }).not.toBeInstanceOf(ResourceError);
  expect(null).not.toBeInstanceOf(ResourceError);
});

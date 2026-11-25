import { required } from "./fixtures/check.ts";
import { expect, test } from "vitest";
import { createLinearSearchResolver } from "#linear/search.ts";
import { createLinearEnvironmentProvider } from "#linear/environment.ts";
const source = "https://linear.app/example/issue/ENG-12/task";
test("pathological regex is bounded and cancellation does not wait for the pattern", async () => {
  const read = async (source: string) => ({
    source,
    content: "a".repeat(40000) + "!",
    complete: true,
  });
  const resolver = createLinearSearchResolver(async () => {
    throw new Error("must not discover");
  }, read);
  const controller = new AbortController();
  const operation = resolver.tryResolve(
    { query: "regex:(a+)+$", path: source },
    { cwd: ".", signal: controller.signal },
  );
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
  } finally {
    clearTimeout(timer);
  }
  const result = await resolver.tryResolve({ query: "regex:(a+)+$", path: source }, { cwd: "." });
  expect(result.kind).toBe("failed");
  if (result.kind === "failed")
    expect(String(result.error)).toContain("LINEAR_TEXT_SEARCH_TIMEOUT");
}, 10000);
test("Search environment is lazy, owns canonical Linear resources only, and never executes local commands", async () => {
  const reads: string[] = [];
  const provider = createLinearEnvironmentProvider(async (source) => {
    reads.push(source);
    return { source, content: "Canonical text", complete: true };
  });
  expect(provider({ query: "word", path: "/local/path" }, { cwd: "." })).toBeUndefined();
  expect(
    provider({ query: "word", path: "https://linear.app/developers/attachments" }, { cwd: "." }),
  ).toBeUndefined();
  const environment = required(provider({ query: "word", path: source }, { cwd: "." }));
  expect(reads).toEqual([]);
  expect(environment.resolve(".", source)).toBe(source);
  expect(await environment.readText(source)).toBe("Canonical text");
  expect(reads).toEqual([source]);
  await expect(environment.runLines([], ".", () => {})).rejects.toThrow(
    "LINEAR_SEARCH_OPTIONS_UNSUPPORTED",
  );
  expect(() => environment.resolve(".", "/local/path")).toThrow("LINEAR_INVALID_SEARCH_SCOPE");
});

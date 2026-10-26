import { ResourceError } from "pi-agent-resource";
import { expect, test } from "vitest";
import { failureResult } from "#src/core/tools/read/read-result.js";
import { structuredRead } from "#src/core/tools/read/structured-result.js";
import { createReadTool } from "#src/core/tools/tool-read.js";

const source = "fixture://owner/note%20caf%C3%A9.txt";
const rateLimit = {
  retryAfterMs: 37_000,
  resetAt: 1_900_000_037_000,
  requestsLimit: 2500,
  requestsRemaining: 0,
  complexityLimit: 3_000_000,
  complexityRemaining: 23,
  endpointLimit: 100,
  endpointRemaining: 0,
  endpoint: "get_project",
};
const privateValue = "fixture-private-transport-value";
function providerFailure(declaredSafe = true) {
  return Object.assign(
    declaredSafe
      ? new ResourceError("RATE_LIMITED", source, "not-applied")
      : Object.assign(new Error(privateValue), { code: "RATE_LIMITED", source }),
    {
      message: privateValue,
      cause: new Error(privateValue),
      headers: { authorization: privateValue },
      metadata: {
        rateLimit: { ...rateLimit, authorization: privateValue, body: privateValue },
        headers: { authorization: privateValue },
        body: privateValue,
      },
    },
  );
}

test("Read keeps the safe provider source when the wrapper has no source", () => {
  const result = structuredRead(
    failureResult({
      code: "RESOLVE_FAILED",
      message: "Resolver failed",
      cause: new ResourceError("TRANSPORT_FAILED", source, "not-applied"),
    }),
  );
  expect(result.structuredContent).toMatchObject({ status: "error", errors: [{ source }] });
});
for (const declaredSafe of [false, true]) {
  test(`Read exposes provider failure codes only when declared safe (${declaredSafe})`, () => {
    const cause = declaredSafe
      ? new ResourceError("AUTH_FAILED", source, "not-applied")
      : Object.assign(new Error("Private transport diagnostic"), { code: "AUTH_FAILED", source });
    cause.message = "Private transport diagnostic";
    const result = structuredRead(
      failureResult({
        code: "RESOLVE_FAILED",
        source,
        message: declaredSafe ? "Private transport diagnostic" : "Resolver fixture failed",
        cause,
      }),
    );
    const code = declaredSafe ? "AUTH_FAILED" : "RESOLVE_FAILED";
    expect(result.structuredContent).toMatchObject({ status: "error", errors: [{ code, source }] });
    const block = result.content[0];
    if (block?.type !== "text") throw new Error("Expected a text failure");
    expect(block.text).toContain(code);
    expect(JSON.stringify(result)).not.toContain("Private transport diagnostic");
  });
}

for (const phase of ["resolve", "read"] as const) {
  test(`Read retains only declared safe retry metadata after a ${phase} failure`, async () => {
    const read = createReadTool();
    const cause = providerFailure();
    let calls = 0;
    read.registerContributions("metadata-fixture", {
      resolvers: [
        {
          resolver: {
            id: "metadata-fixture",
            async tryResolve() {
              if (phase === "resolve") {
                calls++;
                return { kind: "failed", error: cause };
              }
              return {
                kind: "resolved",
                resource: {
                  source,
                  async read() {
                    calls++;
                    throw cause;
                  },
                },
              };
            },
          },
        },
      ],
    });
    try {
      const result = structuredRead(await read.execute({ path: source }, { cwd: "/workspace" }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        status: "error",
        errors: [{ code: "RATE_LIMITED", source, metadata: { rateLimit } }],
      });
      const safe = result.details.failure?.cause as ResourceError & { metadata?: unknown };
      expect(safe).toBeInstanceOf(ResourceError);
      expect(safe).not.toBe(cause);
      expect(safe.metadata).toEqual({ rateLimit });
      expect(safe.cause).toBeUndefined();
      expect(calls).toBe(1);
      expect(JSON.stringify(result)).not.toContain(privateValue);
    } finally {
      await read.dispose();
    }
  });
}

test("Read ignores metadata on an undeclared transport exception", async () => {
  const read = createReadTool();
  read.registerContributions("untrusted-metadata", {
    resolvers: [
      {
        resolver: {
          id: "untrusted-metadata",
          async tryResolve() {
            return { kind: "failed", error: providerFailure(false) };
          },
        },
      },
    ],
  });
  try {
    const result = structuredRead(await read.execute({ path: source }, { cwd: "/workspace" }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "error",
      errors: [{ code: "RESOLVE_FAILED", source }],
    });
    expect(result.details.failure?.cause).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("retryAfterMs");
    expect(JSON.stringify(result)).not.toContain(privateValue);
  } finally {
    await read.dispose();
  }
});

test("the structured Read boundary revalidates metadata from a separately loaded provider", () => {
  const result = structuredRead({
    content: [],
    details: {
      failure: { code: "READ_FAILED", source, message: privateValue, cause: providerFailure() },
    },
    isError: true,
  });
  expect(result.structuredContent).toMatchObject({
    status: "error",
    errors: [{ code: "RATE_LIMITED", source, metadata: { rateLimit } }],
  });
  expect(JSON.stringify(result.structuredContent)).not.toContain(privateValue);
});

test("Read retains the public failure if foreign metadata inspection throws", () => {
  const source = "fixture://resource";
  const original = new ResourceError("RATE_LIMITED", source, "not-applied", {
    metadata: { rateLimit: { retryAfterMs: 37000 } },
  });
  const cause = new Proxy(original, {
    getOwnPropertyDescriptor(target, key) {
      if (key === "metadata") throw Error("fixture-private-descriptor");
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const failure = { code: "READ_FAILED" as const, source, message: "fixture failure", cause };
  const projected = structuredRead(failureResult(failure));
  expect(projected.structuredContent).toMatchObject({
    status: "error",
    errors: [{ code: "RATE_LIMITED", source }],
  });
  expect(JSON.stringify(projected.structuredContent)).not.toContain("fixture-private");
  const base = failureResult({ ...failure, cause: original });
  const direct = structuredRead({ ...base, details: { ...base.details, failure } });
  expect(direct.structuredContent).toMatchObject({
    status: "error",
    errors: [{ code: "RATE_LIMITED", source }],
  });
});

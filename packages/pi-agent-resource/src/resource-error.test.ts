import { expect, test } from "vitest";
import { ResourceError } from "./resource-error.js";
import { resultError, resultErrorSchema } from "./tool-result.js";
import { Value } from "typebox/value";

const rateLimit = {
  retryAfterMs: 37000,
  resetAt: 1900000037000,
  requestsLimit: 2500,
  requestsRemaining: 0,
  complexityLimit: 3000000,
  complexityRemaining: 23,
  endpointLimit: 100,
  endpointRemaining: 0,
  endpoint: "fixture_read",
};

test("explicit safe retry metadata survives the public resource error projection", () => {
  const error = new ResourceError("RATE_LIMITED", "fixture://resource", "not-applied", {
    metadata: { rateLimit },
  });
  expect(error).toMatchObject({ metadata: { rateLimit } });
  expect(resultError(error)).toMatchObject({ code: "RATE_LIMITED", metadata: { rateLimit } });
});

test("public metadata is a frozen snapshot without private transport fields", () => {
  const input = {
    rateLimit: { ...rateLimit, authorization: "fixture-private-token" },
    headers: "fixture-private-header",
  };
  const error = new ResourceError("RATE_LIMITED", "fixture://resource", "unknown", {
    metadata: input,
    cause: new ResourceError("FAILED", "fixture://private", "unknown"),
  });
  const metadata = (error as ResourceError & { metadata?: { rateLimit?: typeof rateLimit } })
    .metadata;
  expect(metadata).toEqual({ rateLimit });
  input.rateLimit.retryAfterMs = 1;
  expect(metadata?.rateLimit?.retryAfterMs).toBe(rateLimit.retryAfterMs);
  expect(Object.isFrozen(metadata)).toBe(true);
  expect(Object.isFrozen(metadata?.rateLimit)).toBe(true);
  expect(JSON.stringify(resultError(error))).not.toContain("fixture-private");
  expect(resultError(error)).not.toHaveProperty("cause");
});

test("only bounded numbers and endpoint identifiers become public retry metadata", () => {
  const error = new ResourceError("RATE_LIMITED", "fixture://resource", "not-applied", {
    metadata: {
      rateLimit: {
        retryAfterMs: 86400001,
        resetAt: NaN,
        requestsLimit: Infinity,
        requestsRemaining: 0,
        complexityLimit: Number.MAX_SAFE_INTEGER + 1,
        complexityRemaining: 1.5,
        endpointLimit: -1,
        endpointRemaining: "private",
        endpoint: "https://private.invalid/?token=secret",
      },
    },
  } as never);
  expect(error.metadata).toEqual({ rateLimit: { requestsRemaining: 0 } });
  const projected = resultError(error);
  expect(Value.Check(resultErrorSchema, projected)).toBe(true);
  expect(
    Value.Check(resultErrorSchema, {
      ...projected,
      metadata: { rateLimit: { retryAfterMs: 86400001 } },
    }),
  ).toBe(false);
  expect(Value.Check(resultErrorSchema, { ...projected, metadata: { headers: "private" } })).toBe(
    false,
  );
});

test("metadata accessors and inherited private fields are not evaluated or copied", () => {
  let accesses = 0;
  const value = { requestsRemaining: 0 };
  Object.defineProperty(value, "retryAfterMs", {
    get() {
      accesses++;
      throw Error("private");
    },
  });
  const error = new ResourceError("RATE_LIMITED", "fixture://resource", "unknown", {
    metadata: { rateLimit: value },
  });
  expect(error.metadata).toEqual({ rateLimit: { requestsRemaining: 0 } });
  expect(accesses).toBe(0);
  const inheritedMetadata = {};
  Object.setPrototypeOf(inheritedMetadata, { rateLimit });
  const inherited = new ResourceError("RATE_LIMITED", "fixture://resource", "unknown", {
    metadata: inheritedMetadata,
  });
  expect(inherited.metadata).toBeUndefined();
});

test("private error messages and nested causes cannot become public result metadata", () => {
  const cause = new ResourceError("RATE_LIMITED", "fixture://private", "unknown", {
    metadata: { rateLimit },
  });
  const error = new ResourceError("FAILED", "fixture://resource", "unknown", { cause });
  error.message = "fixture-private-message";
  const projected = resultError(error);
  expect(projected).toMatchObject({ code: "FAILED", source: "fixture://resource" });
  expect(projected).not.toHaveProperty("metadata");
  expect(JSON.stringify(projected)).not.toContain("fixture-private");
});

test("unreadable optional metadata cannot replace the public resource failure", () => {
  const error = new Proxy(
    new ResourceError("RATE_LIMITED", "fixture://resource", "unknown", {
      metadata: { rateLimit },
    }),
    {
      getOwnPropertyDescriptor(target, key) {
        if (key === "metadata") throw Error("fixture-private-descriptor");
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    },
  );
  const projected = resultError(error);
  expect(projected).toMatchObject({ code: "RATE_LIMITED", source: "fixture://resource" });
  expect(projected).not.toHaveProperty("metadata");
  expect(JSON.stringify(projected)).not.toContain("fixture-private");
});

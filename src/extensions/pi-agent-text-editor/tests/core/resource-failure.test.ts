import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-resource";
import { expect, test } from "vitest";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { executeTextMutation } from "#src/core/text-mutation.js";
import { writeMutationTool } from "#src/tools/tool-text-write.js";

const source = "fixture://owner/note%20caf%C3%A9.txt";
const privateDiagnostic = "Private transport diagnostic";

async function rejectedWrite(error: Error) {
  const core = createTextEditorCore();
  await core.registerPlugin({
    id: "fixture",
    protocol: TEXT_EDITOR_PROTOCOL,
    apiVersion: TEXT_EDITOR_API_VERSION,
    setup(api) {
      api.addResolver({
        resolver: {
          id: "fixture",
          async tryResolve() {
            throw error;
          },
        },
      });
    },
  });
  const context = { cwd: process.cwd() } as ExtensionContext;
  return executeTextMutation(
    core,
    writeMutationTool,
    { path: source, content: "Must not write\n" },
    undefined,
    context,
  );
}

for (const { declaredSafe, effect } of [
  { declaredSafe: false, effect: "not-applied" },
  { declaredSafe: true, effect: "not-applied" },
  { declaredSafe: true, effect: "unknown" },
] as const) {
  test(`edits expose provider failure codes only when declared safe (${declaredSafe}, ${effect})`, async () => {
    const error = declaredSafe
      ? new ResourceError("TRANSPORT_FAILED", source, effect)
      : Object.assign(new Error(privateDiagnostic), {
          code: "TRANSPORT_FAILED",
          source,
          effect: "not-applied",
        });
    error.message = privateDiagnostic;
    const ordinary = await rejectedWrite(error);
    expect(ordinary.details.results?.[0]?.data.errors?.[0]?.code).toBe(
      declaredSafe ? "TRANSPORT_FAILED" : "RESOLVE_FAILED",
    );
    expect(ordinary.details.effect).toBe(effect);
    expect(JSON.stringify(ordinary)).not.toContain(privateDiagnostic);
    if (effect === "unknown") {
      expect(JSON.stringify(ordinary)).toContain("inspect the resource before retrying");
    }
  });
}

test.each(["not-applied", "unknown"] as const)(
  "Write retains a closed immutable retry snapshot without changing %s effects",
  async (effect) => {
    const offered = {
      rateLimit: { retryAfterMs: 37000, authorization: privateDiagnostic },
      headers: privateDiagnostic,
    };
    const error = new ResourceError("RATE_LIMITED", source, effect);
    error.message = privateDiagnostic;
    Object.defineProperty(error, "metadata", { value: offered });
    const result = await rejectedWrite(error);
    const diagnostic = result.details.results?.[0]?.data.errors?.[0];
    const baseline = await rejectedWrite(new ResourceError("RATE_LIMITED", source, effect));
    expect(diagnostic).toEqual({
      ...baseline.details.results?.[0]?.data.errors?.[0],
      metadata: { rateLimit: { retryAfterMs: 37000 } },
    });
    expect(diagnostic).toMatchObject({ path: source, code: "RATE_LIMITED" });
    expect(diagnostic?.metadata).toEqual({ rateLimit: { retryAfterMs: 37000 } });
    expect(result.details.effect).toBe(effect);
    offered.rateLimit.retryAfterMs = 1;
    expect(diagnostic?.metadata?.rateLimit?.retryAfterMs).toBe(37000);
    expect(Object.isFrozen(diagnostic?.metadata)).toBe(true);
    expect(Object.isFrozen(diagnostic?.metadata?.rateLimit)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateDiagnostic);
  },
);

test("Write does not promote metadata on an unbranded exception", async () => {
  const result = await rejectedWrite(
    Object.assign(new Error(privateDiagnostic), {
      metadata: { rateLimit: { retryAfterMs: 37000 }, headers: privateDiagnostic },
    }),
  );
  expect(result.details.results?.[0]?.data.errors?.[0]).not.toHaveProperty("metadata");
  expect(result.details.effect).toBe("not-applied");
  expect(JSON.stringify(result)).not.toContain(privateDiagnostic);
});

test.each(["metadata", "rateLimit", "retryAfterMs"] as const)(
  "Write ignores a foreign %s accessor without replacing its owning failure",
  async (field) => {
    const error = new ResourceError("RATE_LIMITED", source, "unknown");
    const rateLimit = { retryAfterMs: 37000 };
    const metadata = { rateLimit };
    Object.defineProperty(error, "metadata", { value: metadata, configurable: true });
    let reads = 0;
    Object.defineProperty(
      field === "metadata" ? error : field === "rateLimit" ? metadata : rateLimit,
      field,
      {
        get() {
          reads++;
          throw new Error(privateDiagnostic);
        },
      },
    );
    const result = await rejectedWrite(error);
    expect(reads).toBe(0);
    expect(result.details.effect).toBe("unknown");
    expect(result.details.results?.[0]?.data.errors?.[0]).toMatchObject({ code: "RATE_LIMITED" });
    expect(result.details.results?.[0]?.data.errors?.[0]).not.toHaveProperty("metadata");
    expect(JSON.stringify(result)).not.toContain(privateDiagnostic);
  },
);

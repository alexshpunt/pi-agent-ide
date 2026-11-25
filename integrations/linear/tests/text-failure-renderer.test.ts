import { required } from "./fixtures/check.ts";
import { expect, test } from "vitest";
import type { TextEditorPluginApi } from "pi-agent-ide/api/text-editor";
import { registerLinearFailureRenderers } from "#linear/text-failure-renderer.ts";

type Registration = Parameters<TextEditorPluginApi["addToolRenderer"]>[0];
type ResultRenderer = NonNullable<Registration["renderResult"]>;
const source = "linear://example/document/71000000-0000-4000-8000-000000000006/content";
const privateBody = "PRIVATE_BACKEND_BODY auth=secret-value";

function renderer() {
  const registrations: Registration[] = [];
  const api = {
    addToolRenderer(registration: Registration) {
      registrations.push(registration);
    },
  };
  registerLinearFailureRenderers(api);

  return required(registrations.at(0));
}
function failure(
  effect: "unknown" | "applied" | "not-applied" = "unknown",
  code = "LINEAR_AXI_FAILED",
) {
  return {
    content: [{ type: "text" as const, text: privateBody }],
    details: {
      effect,
      results: [
        {
          data: {
            kind: "fail",
            ok: false,
            errors: [
              {
                path: source,
                code: "WRITE_FAILED",
                reason: `Unable to write ${source}: ${code}: ${source}.`,
              },
            ],
          },
        },
      ],
    },
  };
}
function displayed(registration: Registration, value: unknown, expanded: boolean) {
  const theme = {
    fg: (_color: string, value: string) => value,
  } as Parameters<ResultRenderer>[2];
  const component = required(registration.renderResult)(
    value as Parameters<ResultRenderer>[0],
    { expanded, isPartial: false },
    theme,
    { isError: true } as Parameters<ResultRenderer>[3],
  );
  return component.render(60).join("\n");
}

test("Linear installs its recovery renderer for all six mutation tools", () => {
  const registrations: Registration[] = [];
  registerLinearFailureRenderers({
    addToolRenderer: (registration) => registrations.push(registration),
  });
  expect(registrations.map((item) => item.tool)).toEqual([
    "write",
    "replace",
    "insert",
    "delete",
    "copy",
    "move",
  ]);
});

test.each([false, true])(
  "a Linear unknown-effect failure is actionable when expanded=%s",
  (expanded) => {
    const registration = renderer();
    const value = failure();
    expect(required(registration.matches)(value, "result")).toBe(true);
    const shown = displayed(registration, value, expanded);
    expect(shown).toContain("Effects unknown");
    expect(shown).toContain("The Linear request failed.");
    expect(shown).toContain("Read the affected resource before retrying");
    expect(shown).not.toContain(privateBody);
    expect(shown).not.toContain("WRITE_FAILED");
  },
);
test.each([
  ["LINEAR_READBACK_UNAVAILABLE", "Could not read the saved resource"],
  ["LINEAR_STALE_CONTENT", "The resource changed since it was read"],
  ["LINEAR_AUTH_REQUIRED", "Linear authorization is required"],
])("known provider failures explain %s without dumping diagnostics", (code, message) => {
  const registration = renderer();
  const value = failure("unknown", code);
  expect(required(registration.matches)(value, "result")).toBe(true);
  expect(displayed(registration, value, false)).toContain(message);
});
test.each([false, true])(
  "an unverified edit snapshot explains ordinary Read recovery when expanded=%s",
  (expanded) => {
    const registration = renderer();
    const value = failure("not-applied", "LINEAR_SNAPSHOT_UNVERIFIED");
    const error = value.details.results[0].data.errors[0];
    error.path = "linear://example/issue/ENG-12#priority";
    error.code = "LINEAR_SNAPSHOT_UNVERIFIED";
    error.reason = privateBody;
    expect(required(registration.matches)(value, "result")).toBe(true);
    const shown = displayed(registration, value, expanded).replace(/\s+/gu, " ");
    expect(shown).toContain("Not changed");
    expect(shown).toContain("Read the original resource without jq before editing.");
    expect(shown).not.toContain("Effects unknown");
    expect(shown).not.toContain("resource write failed");
    expect(shown).not.toContain("LINEAR_SNAPSHOT_UNVERIFIED");
    expect(shown).not.toContain(privateBody);
  },
);
test.each(["applied", "not-applied"] as const)("the %s effect stays truthful", (effect) => {
  const registration = renderer();
  const value = failure(effect);
  const shown = displayed(registration, value, false);
  expect(shown).toContain(
    effect === "applied" ? "Saved · follow-up unavailable" : "Not changed · edit failed",
  );
  expect(shown).not.toContain("Effects unknown");
});
test.each([
  ["LINEAR_OPERATION_CONNECT_FAILED", "not-applied"],
  ["LINEAR_OPERATION_PERMISSION_DENIED", "unknown"],
  ["LINEAR_OPERATION_RATE_LIMITED", "unknown"],
] as const)("staged creation failures select a safe provider panel: %s", (code, effect) => {
  const registration = renderer();
  const value = failure(effect, code);
  expect(required(registration.matches)(value, "result")).toBe(true);
  const shown = displayed(registration, value, false);
  expect(shown).not.toContain(privateBody);
  expect(shown).not.toContain(code);
});
test("only known Linear failures select the renderer", () => {
  const registration = renderer();
  expect(required(registration.matches)({ path: source }, "call")).toBe(false);
  expect(
    required(registration.matches)(
      { content: [], details: { effect: "applied", results: [] } },
      "result",
    ),
  ).toBe(false);
  expect(
    required(registration.matches)(failure("unknown", "UNRECOGNIZED_PROVIDER_ERROR"), "result"),
  ).toBe(false);
  const local = failure();
  local.details.results[0].data.errors[0].path = "/tmp/local.txt";
  expect(required(registration.matches)(local, "result")).toBe(false);
  const misleading = failure();
  misleading.details.results[0].data.errors[0].reason = `Private body mentions LINEAR_SAVED_CONTENT_MISMATCH: ${privateBody}`;
  expect(required(registration.matches)(misleading, "result")).toBe(false);
  expect(
    required(registration.matches)(
      { details: { results: [{ data: { errors: "invalid" } }] } },
      "result",
    ),
  ).toBe(false);
});
test("a restoration hint cannot hide an unknown overall effect", () => {
  const registration = renderer();
  const value = failure();
  Object.assign(value.details, { metadata: { rollback: "restored" } });
  expect(displayed(registration, value, false)).toContain("Effects unknown");
});
test("mixed provider failures delegate rather than hiding other causes", () => {
  const registration = renderer();
  const value = failure();
  value.details.results[0].data.errors.push({
    path: "/tmp/local.txt",
    code: "EACCES",
    reason: "denied",
  });
  expect(required(registration.matches)(value, "result")).toBe(false);
});
test.each([
  [[], [source], "Effects unknown"],
  [[source], [], "State unknown · rollback failed"],
])(
  "rollback information never becomes a clean failure",
  (failedSources, restoredSources, label) => {
    const registration = renderer();
    const value = failure();
    Object.assign(value.details.results[0].data, { rollback: { failedSources, restoredSources } });
    expect(displayed(registration, value, false)).toContain(label);
  },
);

test.each(["INVALID_REQUEST", "POST_WRITE_FAILED"])(
  "semantic wrappers retain a safe Linear reason: %s",
  (code) => {
    const value = failure("applied", "LINEAR_READBACK_UNAVAILABLE");
    value.details.results[0].data.errors[0] = {
      path: source,
      code,
      reason: `LINEAR_READBACK_UNAVAILABLE: ${source}`,
    };
    const registration = renderer();
    expect(required(registration.matches)(value, "result")).toBe(true);
    expect(displayed(registration, value, false)).toContain("Saved · follow-up unavailable");
    expect(displayed(registration, value, false).replace(/\s+/gu, " ")).toContain(
      "Read it again before editing",
    );
  },
);

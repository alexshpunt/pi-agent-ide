import { createTextDocument } from "pi-agent-text";
import { expect, test, vi } from "vitest";

import { runIdePostEditGate } from "#src/post-edit/gate.js";

import type { IdePostEditGateRunner } from "#src/post-edit/gate.js";
import type { Diagnostic, GateResult } from "#src/toolchain/types.js";
import type { TextPostEditTransaction } from "pi-agent-text-editor/api/post-edit";

const syntaxError: Diagnostic = {
  line: 1,
  column: 7,
  severity: "error",
  code: "TS2322",
  message: "Type number is not assignable to string",
};

function transaction(resourceSource = "/workspace/src/example.ts"): TextPostEditTransaction {
  return {
    source: resourceSource.startsWith("/") ? "src/example.ts" : resourceSource,
    resourceSource,
    resolvedBy: resourceSource.startsWith("/") ? "filesystem" : "memory",
    cwd: "/workspace",
    before: createTextDocument(resourceSource, "const value = 1;\n"),
    requestedAfter: createTextDocument(resourceSource, "const value: string = 1;\n"),
  };
}

function gateResult(filePath: string): GateResult {
  return {
    stage: "done",
    rollback: false,
    files: [
      {
        filePath,
        sourceContent: "const value = 1;\n",
        finalContent: "const value: string = 1;\n",
        compile: {
          ok: false,
          diagnostics: [syntaxError],
          syntaxErrors: [syntaxError],
          otherDiagnostics: [],
        },
        format: { ok: true, edits: 0 },
        lint: { ok: true, diagnostics: [] },
      },
    ],
  };
}

test("collects post-edit diagnostics without formatting anchors", async () => {
  const implementation: IdePostEditGateRunner = (filePath, toolchain) => {
    expect(filePath).toBe("/workspace/src/example.ts");
    expect(toolchain.ctx.cwd).toBe("/workspace");
    return Promise.resolve(gateResult(filePath));
  };
  const runGate = vi.fn(implementation);

  const result = await runIdePostEditGate(transaction(), runGate);

  expect(result).toEqual({
    hints: [
      {
        file: "src/example.ts",
        line: 1,
        column: 7,
        lineText: "const value: string = 1;",
        severity: "error",
        source: "compiler",
        code: "TS2322",
        message: "Type number is not assignable to string",
      },
    ],
    scopeMarkers: {},
    warnings: [],
  });
  expect(result?.hints[0]).not.toHaveProperty("anchor");
  expect(runGate).toHaveBeenCalledOnce();
});

test("ignores resources without an absolute filesystem identity", async () => {
  const runGate = vi.fn<IdePostEditGateRunner>();

  await expect(
    runIdePostEditGate(transaction("memory:example.ts"), runGate),
  ).resolves.toBeUndefined();
  expect(runGate).not.toHaveBeenCalled();
});

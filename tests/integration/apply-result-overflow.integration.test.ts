import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutionResult,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";

test.each([false, true])(
  "Apply bounds committed bulk results and preserves receipt undo (explicit flush: %s)",
  async (explicitFlush) => {
    await withTempWorkspace(async (cwd) => {
      const source = Array.from(
        { length: 1000 },
        (_, index) =>
          `test("serializes checkout‑payload ${index}", () => {\n  // ${"x".repeat(500)}\n  const input = {\n    feature: "legacy\u200bCheckout",\n    requestId: "request-${index}",\n    retryCount: ${index % 4},\n    headers: { accept: "application/json" },\n  };\n  const encoded = JSON.stringify(input);\n  expect(JSON.parse(encoded)).toEqual(input);\n});\n`,
      ).join("");
      await writeFile(path.join(cwd, "cases.txt"), source);
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({ noAnimations: true }),
      );
      const run = await new PiIntegrationTest({
        testName: `apply-result-overflow-${explicitFlush}`,
        rawMode: false,
        transport: "tui",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          path.resolve("tests/integration/fixtures/apply-bulk-result-probe.ts"),
        ],
        tools: ["apply", "undo", "read", "apply_bulk_result_probe"],
        timeoutMs: 120_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "bulk",
                name: "apply",
                arguments: {
                  source:
                    'const file = open("cases.txt"); replace(file.find("legacy\\u200bCheckout"), "stable\\u200bCheckout");' +
                    (explicitFlush
                      ? ' const receipt = flush(); if (!receipt.ok || receipt.effect !== "applied" || !receipt.fullResult) throw new Error("Missing committed bridge summary"); if (file.find("stable\\u200bCheckout").length !== 1000) throw new Error("Snapshot refresh failed"); return receipt;'
                      : ""),
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [toolCall({ id: "probe", name: "apply_bulk_result_probe", arguments: {} })],
            { stopReason: "toolUse" },
          ),
          assistantMessage([text("Done")]),
        ],
      }).run("Check bulk Apply output and undo by its committed receipt");
      expect(run.tuiRenderedOutput).toContain("Apply · JavaScript");
      expect(run.tuiRenderedOutput).toContain("cases.txt");
      expect(run.tuiRenderedOutput).toContain('"undoError":false');
      expect(run.tuiRenderedOutput).not.toContain("RUN_SERIALIZATION_ERROR");
      const execution = getToolExecution(run, "bulk");
      expect(execution.isError, JSON.stringify(execution)).toBe(false);
      const structured = (
        getToolExecutionResult(run, "bulk") as {
          structuredContent: {
            status: string;
            errors: unknown[];
            data: {
              truncated: boolean;
              fullResult: string;
              transactions: string[];
              operations: Array<{
                kind: string;
                fullResultBytes: number;
                data: { effect: string; operations: Array<{ effect: string; status: string }> };
              }>;
            };
          };
        }
      ).structuredContent;
      expect(structured.status).toBe("success");
      expect(structured.errors).toEqual([]);
      expect(structured.data.truncated).toBe(true);
      expect(structured.data.fullResult).toMatch(/^temp:/u);
      expect(structured.data.transactions).toEqual([
        expect.stringMatching(/^APPLY#[0-9A-F]{12}$/u),
      ]);
      const mutations = structured.data.operations.filter(
        (operation) => operation.kind === "mutation",
      );
      expect(mutations).toHaveLength(1);
      const mutation = mutations[0];
      if (!mutation) throw new Error("Missing mutation summary");
      expect(mutation.data.effect).toBe("applied");
      expect(mutation.data.operations).toHaveLength(1000);
      expect(
        mutation.data.operations.every(
          (operation) => operation.effect === "applied" && operation.status === "success",
        ),
      ).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(structured))).toBeLessThan(512 * 1024);
      const details = getToolExecutionDetails(getToolExecution(run, "probe")) as {
        reference: { isError: boolean };
        bridge: { isError: boolean };
        undo: { isError: boolean };
      };
      expect(details.reference.isError).toBe(false);
      expect(details.bridge.isError).toBe(false);
      expect(mutation.fullResultBytes).toBeGreaterThan(4 * 1024 * 1024);
      expect(details.undo.isError).toBe(false);
      expect(
        (await readFile(path.join(cwd, "edited.bin"))).equals(
          Buffer.from(source.replaceAll("legacy\u200bCheckout", "stable\u200bCheckout")),
        ),
      ).toBe(true);
      expect((await readFile(path.join(cwd, "cases.txt"))).equals(Buffer.from(source))).toBe(true);
    });
  },
);

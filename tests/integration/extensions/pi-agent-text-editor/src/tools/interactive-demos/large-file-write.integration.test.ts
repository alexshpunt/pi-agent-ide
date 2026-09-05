import { readFile } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import {
  assistantMessage,
  getToolCallNames,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
const extensions = createExtensionSet();
const defaultTextEditorExtension = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/register-extension.ts",
);
const rendererTestStand = path.resolve(
  "tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/register-extension.ts",
);
const overwriteGuardExtension = path.resolve(
  "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-overwrite/index.ts",
);
const demoFileName = "worker-catalog-write-demo.ts";
const live = process.env.PI_INTEGRATION_TEST_LIVE === "1";
const interactivePacing = live ? {} : { chunks: { kind: "fixed" as const, size: 512 }, delayMs: 0 };

interface CatalogRevision {
  readonly revision: string;
  readonly region: string;
  readonly queuePrefix: string;
  readonly concurrencyBase: number;
  readonly timeoutBase: number;
  readonly retryBase: number;
  readonly status: string;
}

const initialContent = buildWorkerCatalog({
  revision: "2026.08-a",
  region: "eu-central",
  queuePrefix: "jobs",
  concurrencyBase: 2,
  timeoutBase: 1_500,
  retryBase: 2,
  status: "ready",
});
const overwriteContent = buildWorkerCatalog({
  revision: "2026.08-b",
  region: "eu-west",
  queuePrefix: "tasks",
  concurrencyBase: 5,
  timeoutBase: 2_300,
  retryBase: 4,
  status: "active",
});

afterAll(() => extensions.dispose());

describe("interactive text editor demos", () => {
  test("streams a large file write and guarded overwrite", async () => {
    await withTempWorkspace(async (directory) => {
      const createCallId = "demo-large-write-create";
      const blockedOverwriteCallId = "demo-large-write-overwrite-blocked";
      const confirmedOverwriteCallId = "demo-large-write-overwrite-confirmed";
      const result = await new PiIntegrationTest({
        testName: "interactive-demo-large-file-write",
        cwd: directory,
        extensions: [
          ...extensions.paths.map((extension) =>
            extension === defaultTextEditorExtension ? rendererTestStand : extension,
          ),
          overwriteGuardExtension,
        ],
        tools: ["write", "read"],
        rawMode: false,
        timeoutMs: 180_000,
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: createCallId,
                name: "write",
                arguments: { path: demoFileName, content: initialContent },
                ...interactivePacing,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [toolCall({ id: "read-created", name: "read", arguments: { path: demoFileName } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: blockedOverwriteCallId,
                name: "write",
                arguments: { path: demoFileName, content: overwriteContent },
                ...interactivePacing,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [toolCall({ id: "read-blocked", name: "read", arguments: { path: demoFileName } })],
            { stopReason: "toolUse" },
          ),
          assistantMessage(
            [
              toolCall({
                id: confirmedOverwriteCallId,
                name: "write",
                arguments: { path: demoFileName, content: overwriteContent },
                ...interactivePacing,
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([
            text("The large write and guarded overwrite demo is complete", { delayMs: 0 }),
          ]),
        ],
      }).run("Write a large TypeScript file, then confirm its complete overwrite");

      const createExecution = getToolExecution(result, createCallId);
      const blockedOverwriteExecution = getToolExecution(result, blockedOverwriteCallId);
      const confirmedOverwriteExecution = getToolExecution(result, confirmedOverwriteCallId);
      expect(getToolCallNames(result).filter((name) => name === "write")).toEqual([
        "write",
        "write",
        "write",
      ]);
      expect(createExecution.isError).toBe(false);
      expect(blockedOverwriteExecution.isError).toBe(true);
      expect(getToolResultText(result, blockedOverwriteCallId)).toContain(
        "Reason: The file already exists",
      );
      expect(confirmedOverwriteExecution.isError).toBe(false);

      for (const id of ["read-created", "read-blocked"]) {
        expect(getToolExecution(result, id).isError).not.toBe(true);
        expect(getToolResultText(result, id)).toBe(initialContent);
      }
      await expect(readFile(path.join(directory, demoFileName), "utf8")).resolves.toBe(
        overwriteContent,
      );

      const terminalOutput = stripVTControlCharacters(result.terminalOutput);
      if (live) {
        expect(terminalOutput).toMatch(/jobs-worker-[^\n]*▌/u);
        expect(terminalOutput).toMatch(/tasks-worker-[^\n]*▌/u);
        expect(terminalOutput).toContain("workers ready for eu-central");
        expect(terminalOutput).toContain("workers active for eu-west");
      }
    });
  }, 180_000);
});

function buildWorkerCatalog(revision: CatalogRevision): string {
  const workers = Array.from({ length: 14 }, (_, index) => {
    const number = index + 1;
    const suffix = String(number).padStart(2, "0");
    const mode = number % 2 === 0 ? "parallel" : "serial";

    return [
      "    {",
      `        name: "${revision.queuePrefix}-worker-${suffix}",`,
      `        queue: "${revision.queuePrefix}-${suffix}",`,
      `        mode: "${mode}",`,
      `        concurrency: ${revision.concurrencyBase + number},`,
      `        timeoutMs: ${revision.timeoutBase + number * 125},`,
      `        retryLimit: ${revision.retryBase + (number % 3)},`,
      "    },",
    ];
  }).flat();

  return [
    'export type WorkerMode = "serial" | "parallel";',
    "",
    "export interface WorkerDefinition",
    "{",
    "    readonly name: string;",
    "    readonly queue: string;",
    "    readonly mode: WorkerMode;",
    "    readonly concurrency: number;",
    "    readonly timeoutMs: number;",
    "    readonly retryLimit: number;",
    "}",
    "",
    `export const CATALOG_REVISION = "${revision.revision}";`,
    `export const DEFAULT_REGION = "${revision.region}";`,
    "",
    "export const workers = [",
    ...workers,
    "] as const satisfies readonly WorkerDefinition[];",
    "",
    "export function workerByName(name: string): WorkerDefinition | undefined",
    "{",
    "    return workers.find((worker) => worker.name === name);",
    "}",
    "",
    "export function workersForMode(mode: WorkerMode): readonly WorkerDefinition[]",
    "{",
    "    return workers.filter((worker) => worker.mode === mode);",
    "}",
    "",
    "export function summarizeWorkers(): string",
    "{",
    `    return \`${workers.length / 8} workers ${revision.status} for ${revision.region}\`;`,
    "}",
    "",
  ].join("\n");
}

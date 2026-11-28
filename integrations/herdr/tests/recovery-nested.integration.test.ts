import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";
import { currentIde } from "./fixtures/current-ide.ts";

const root = path.dirname(import.meta.dirname);
const once = { chunks: { kind: "fixed" as const, size: Number.MAX_SAFE_INTEGER } };

test("a nested Herdr result is persisted before its recovery acknowledgement", async () => {
  const ide = await currentIde();
  await mkdir(path.join(root, ".tmp"), { recursive: true });
  const cwd = await mkdtemp(path.join(root, ".tmp", "herdr-recovery-nested-"));
  try {
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/settings.json"),
      JSON.stringify({ codemode: { mode: "on" } }),
    );
    const result = await new PiIntegrationTest({
      testName: "herdr-recovery-nested",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      isolateUserResources: true,
      extensions: [
        ide.extension,
        path.join(root, "tests/fixtures/recovery-bridge.ts"),
        "builtin:codemode",
      ],
      tools: ["read", "codemode"],
      timeoutMs: 90000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "nested",
              name: "codemode",
              arguments: { code: 'text(await tools.read({path:"herdr:"}))' },
              ...once,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Fixture complete.", once)]),
      ],
    }).run("Read the Herdr list through Codemode.");
    await ide.record(result.artifacts.directory);
    expect(getToolExecution(result, "nested").isError).toBe(false);
    const snapshot = result.traceEvents.findLast((event) => event.type === "session_snapshot");
    const branch = snapshot?.branch as {
      type: string;
      customType?: string;
      details?: { items?: { id: string; revision: string }[] };
    }[];
    const deliveries = branch.filter(
      (entry) => entry.type === "custom_message" && entry.customType === "herdr-recovery",
    );
    expect(deliveries.flatMap((entry) => entry.details?.items ?? [])).toContainEqual({
      id: "fixture-1",
      revision: "revision-1",
    });
    const acknowledgements: unknown = JSON.parse(
      await readFile(path.join(cwd, "recovery-ack.json"), "utf8"),
    );
    expect(acknowledgements).toContainEqual({
      id: "fixture-1",
      revision: "revision-1",
      persisted: true,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 120000);

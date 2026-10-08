import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { inspectRecipeEvidence } from "pi-agent-doctor/api/evidence";
import {
  hasConfiguredExecutable,
  resolveExternalToolProjectRoot,
  toolRuntimeEvidence,
} from "./tool-config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test.each([
  [
    "project discovery",
    (signal: AbortSignal) =>
      resolveExternalToolProjectRoot(
        "/unused-owner",
        "/external/note.ts",
        "lsp-servers",
        [],
        signal,
      ),
  ],
  [
    "executable availability",
    (signal: AbortSignal) =>
      hasConfiguredExecutable({ command: [process.execPath] }, process.cwd(), process.env, signal),
  ],
  [
    "runtime evidence",
    (signal: AbortSignal) =>
      toolRuntimeEvidence(process.cwd(), [], [], { includeGlobal: false, signal }),
  ],
] as const)("cancelled local %s retains the cancellation", async (_name, run) => {
  const controller = new AbortController();
  const reason = new Error("Cancel native discovery");
  controller.abort(reason);
  await expect(run(controller.signal)).rejects.toBe(reason);
});

test.each(["project", "executable"] as const)(
  "cancelling an issued native %s check retains its reason",
  async (kind) => {
    const controller = new AbortController();
    const reason = new Error("Cancel issued native check");
    const pending = (
      kind === "project"
        ? resolveExternalToolProjectRoot(
            "/unused-owner",
            "/external/note.ts",
            "lsp-servers",
            [],
            controller.signal,
          )
        : hasConfiguredExecutable(
            { command: [process.execPath] },
            process.cwd(),
            process.env,
            controller.signal,
          )
    ).catch((error: unknown) => error);
    controller.abort(reason);
    expect(await pending).toBe(reason);
  },
);

test("cancelling a native evidence read retains its reason rather than scoring a missing manifest", async () => {
  const base = path.resolve(".tmp/tool-discovery-cancellation");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, "owned-"));
  directories.push(directory);
  await writeFile(path.join(directory, "package.json"), `${" ".repeat(8 * 1024 * 1024)}{}`);
  const controller = new AbortController();
  const reason = new Error("Cancel native evidence read");
  const pending = inspectRecipeEvidence(directory, [], undefined, controller.signal).catch(
    (error: unknown) => error,
  );
  controller.abort(reason);
  expect(await pending).toBe(reason);
  await expect(inspectRecipeEvidence(directory, [])).resolves.toEqual(new Map());
});

test("owned evidence receives the invocation signal and preserves its cancellation reason", async () => {
  const controller = new AbortController();
  const reason = new Error("Cancel owned evidence");
  let invokedSignal: AbortSignal | undefined;
  const pending = inspectRecipeEvidence(
    "ssh://fixture/project",
    [],
    {
      readText: (_file, signal) => {
        invokedSignal = signal;
        return new Promise<string | undefined>((_resolve, reject) => {
          if (!signal) return reject(new Error("Missing owner evidence signal"));
          signal.addEventListener("abort", () => reject(new Error("Owner read cancelled")), {
            once: true,
          });
        });
      },
      hasMarker: async () => false,
    },
    controller.signal,
  ).catch((error: unknown) => error);
  expect(invokedSignal).toBe(controller.signal);
  controller.abort(reason);
  expect(await pending).toBe(reason);
});

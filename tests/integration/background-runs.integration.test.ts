import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getCurrentTools, type Message } from "@earendil-works/pi-ai";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { expect, test } from "vitest";

const root = process.cwd();
const temporary = path.join(root, ".tmp/background-run-tests");
const probe = path.join(root, "tests/integration/fixtures/background-run-probe.ts");
const review = path.join(root, "tests/integration/code-review/fixture.ts");
interface Observation {
  starts: { kind: string; idle: boolean }[];
  settlements: { aborted: boolean; idle: boolean }[];
  maxActiveRuns: number;
  customTypes: string[];
}

for (const mode of ["terminal", "review", "queue", "abort"] as const) {
  test.runIf(mode !== "terminal" || process.platform !== "win32")(
    `prepares an extension-triggered run and preserves its effects: ${mode}`,
    async () => {
      await mkdir(temporary, { recursive: true });
      const cwd = await mkdtemp(path.join(temporary, `${mode}-`));
      const view = `generation-${randomUUID()}`;
      try {
        const config = path.join(cwd, ".pi/pi-agent-ide");
        await mkdir(config, { recursive: true });
        await writeFile(path.join(cwd, "background-case.json"), JSON.stringify({ mode, view }));
        await writeFile(path.join(cwd, "review-case.json"), JSON.stringify({ mode: "idle" }));
        await writeFile(path.join(cwd, "file.ts"), "throw error;\n");
        await writeFile(
          path.join(config, "extensions.json"),
          JSON.stringify({
            preset: mode === "terminal" ? "full" : "text-editor",
            disabled: ["ide.ast"],
            flags: {
              "pi-agent-ide-code-review": mode === "review",
              "pi-agent-ide-no-animations": true,
              "pi-agent-ide-no-post-processing": true,
            },
          }),
        );
        if (mode === "review") {
          await writeFile(
            path.join(config, "code-review.yaml"),
            "rules:\n  - id: hidden-errors\n    description: Do not hide operation failures.\n",
          );
        }
        const initial =
          mode === "terminal"
            ? [
                assistantMessage(
                  [
                    toolCall({
                      id: "background-command",
                      name: "bash",
                      arguments: {
                        command:
                          "while [ ! -f background-release ]; do sleep 0.02; done; printf background-completed",
                        background: true,
                      },
                    }),
                  ],
                  { stopReason: "toolUse" },
                ),
              ]
            : mode === "review"
              ? [
                  assistantMessage(
                    [toolCall({ id: "before", name: "read", arguments: { path: "file.ts" } })],
                    { stopReason: "toolUse" },
                  ),
                  assistantMessage(
                    [
                      toolCall({
                        id: "edit",
                        name: "write",
                        arguments: { path: "file.ts", content: "return null;\n" },
                      }),
                    ],
                    { stopReason: "toolUse" },
                  ),
                ]
              : [];
        const conversation = [
          ...initial,
          assistantMessage([text("The initial run is finished.", { delayMs: 0 })]),
          assistantMessage(
            [
              toolCall({
                id: "late-read",
                name: "read",
                arguments: { path: "file.ts", views: [view] },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([toolCall({ id: "ack", name: "background_probe", arguments: {} })], {
            stopReason: "toolUse",
          }),
          assistantMessage([text("Background notification acknowledged.", { delayMs: 0 })]),
        ];
        const result = await new PiIntegrationTest({
          testName: `background-start-${mode}`,
          cwd,
          artifactsDir: testArtifactsDir(import.meta.filename),
          extensions: [
            path.join(root, "src/pi-agent-ide.ts"),
            probe,
            ...(mode === "review" ? [review] : []),
          ],
          tools: ["read", "write", "background_probe", ...(mode === "terminal" ? ["bash"] : [])],
          piCommand: process.env.PI_COMMAND ?? "pi",
          rawMode: false,
          transport: "tui",
          isolateUserResources: true,
          environment: {
            PI_CODING_AGENT_DIR: path.join(cwd, ".pi"),
            PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "1",
            TYPESAFE_API_KEY: "",
            OPENROUTER_API_KEY: "",
            AI_GATEWAY_API_KEY: "",
            OPENCODE_API_KEY: "",
            CLOUDFLARE_API_KEY: "",
          },
          conversation,
        }).run("Finish the initial work and handle the background notification.");

        // Check a generated capability identifier, not the prose of any instruction or guide.
        const readSchema = (request: number) =>
          getCurrentTools(result.providerRequests[request]?.messages as Message[]).find(
            (tool) => tool.name === "read",
          )?.parameters;
        expect(JSON.stringify(readSchema(0))).not.toContain(view);
        expect(JSON.stringify(readSchema(initial.length + 1))).toContain(view);
        expect(getToolExecution(result, "late-read").isError).toBe(false);
        expect(getToolResultText(result, "late-read")).toContain(`${view}|`);
        expect(getToolExecution(result, "ack").isError).toBe(false);
        const observation = JSON.parse(
          await readFile(path.join(cwd, "background-observation.json"), "utf8"),
        ) as Observation;
        expect(observation.starts.map((start) => start.kind)).toEqual(
          mode === "abort" ? ["user", "custom", "custom"] : ["user", "custom"],
        );
        expect(observation.starts.every((start) => !start.idle)).toBe(true);
        expect(observation.maxActiveRuns).toBe(1);
        expect(observation.settlements[0]).toEqual({ aborted: false, idle: true });
        expect(result.providerRequests).toHaveLength(conversation.length);
        expect(result.state?.hasPendingMessages).toBe(false);
        if (mode === "queue" || mode === "abort") {
          expect(observation.customTypes.filter((type) => type === "startup-queued")).toHaveLength(
            1,
          );
        }
        if (mode === "abort") {
          expect(observation.settlements.filter((settled) => settled.aborted)).toHaveLength(1);
          expect(
            observation.customTypes.filter((type) => type === "fixture-recovery"),
          ).toHaveLength(1);
        }
        const notification =
          mode === "terminal"
            ? "terminal-completion"
            : mode === "review"
              ? "ide-code-review"
              : "fixture-wakeup";
        expect(observation.customTypes.filter((type) => type === notification)).toHaveLength(1);
        if (mode === "review") {
          expect(await readFile(path.join(cwd, "file.ts"), "utf8")).toBe("return null;\n");
          expect(
            JSON.parse((await readFile(path.join(cwd, "review-idle.jsonl"), "utf8")).trim()),
          ).toEqual({ idle: true });
          expect(
            (await readFile(path.join(cwd, "review-calls.jsonl"), "utf8")).trim().split("\n"),
          ).toHaveLength(1);
        }
      } finally {
        await rm(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    },
  );
}

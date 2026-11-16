import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutions,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { startSshFixture } from "#integration/support/ssh-fixture.ts";

const chunks = { kind: "fixed", size: Number.MAX_SAFE_INTEGER } as const;
const restore = forceStandaloneIntegrationFile();
afterAll(restore);

for (const remote of [false, true]) {
  for (const native of [false, true]) {
    const route = `${remote ? "SSH" : "local"} ${native ? "Codemode" : "direct"}`;
    test.runIf(process.platform !== "win32")(
      `${route} reads a completed shell as an image and a sequence without ignoring either view`,
      async () => {
        const fixture = remote ? await startSshFixture() : undefined;
        const root = path.resolve(".tmp/terminal-visual-views");
        await mkdir(root, { recursive: true });
        const cwd = await mkdtemp(path.join(root, "case-"));
        try {
          await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
          await writeFile(
            path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
            JSON.stringify({
              noAnimations: true,
              noPostProcessing: true,
              disabled: [
                "ide.ast",
                "ide.lsp",
                "ide.formatter",
                "ide.lint",
                "ide.changes",
                "ide.diagnostics",
                "ide.debugger",
              ],
            }),
          );
          if (fixture) {
            await writeFile(
              path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
              JSON.stringify({
                targets: [
                  {
                    id: "fixture",
                    host: "fixture",
                    workspace: fixture.workspace,
                    configFile: fixture.config,
                  },
                ],
              }),
            );
          }
          const bashArgs = {
            command: "printf 'VISUAL-SCREEN\\n'",
            name: "visual-screen",
            ...(fixture ? { cwd: `ssh://fixture${fixture.workspace}` } : {}),
          };
          const imageArgs = { path: "shell:visual-screen", views: ["image:scale=0.5"] };
          const sequenceArgs = {
            path: "shell:visual-screen",
            views: ["sequence:duration=0.2,interval=0.1,scale=0.5"],
          };
          const code = `
const shell = await tools.bash(${JSON.stringify(bashArgs)});
if (shell.exit_code !== 0) throw new Error("Shell did not complete successfully");
const screen = await tools.read({ ...${JSON.stringify(imageArgs)}, path: shell.session });
const frames = await tools.read({ ...${JSON.stringify(sequenceArgs)}, path: shell.session });
if (screen.type !== "image" || screen.mimeType !== "image/png" || frames.type !== "images" || frames.images.length !== 3) throw new Error("Unexpected native terminal image values");
image(screen);
for (const frame of frames.images) image(frame);
`;
          const conversation = native
            ? [
                assistantMessage([
                  toolCall({ id: "script", name: "codemode", arguments: { code }, chunks }),
                ]),
              ]
            : [
                assistantMessage([
                  toolCall({ id: "shell", name: "bash", arguments: bashArgs, chunks }),
                ]),
                assistantMessage([
                  toolCall({ id: "screen", name: "read", arguments: imageArgs, chunks }),
                ]),
                assistantMessage([
                  toolCall({ id: "frames", name: "read", arguments: sequenceArgs, chunks }),
                ]),
              ];
          const run = await new PiIntegrationTest({
            testName: `terminal-visual-${remote ? "ssh" : "local"}-${native ? "codemode" : "direct"}`,
            artifactsDir: testArtifactsDir(import.meta.filename),
            cwd,
            isolateUserResources: true,
            extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
            tools: ["bash", "read", "codemode"],
            environment: { SHELL: "/bin/bash" },
            timeoutMs: 60_000,
            conversation: [...conversation, assistantMessage([text("Done", { chunks })])],
          }).run("Capture the completed shell screen and three sequence frames.");
          if (native) {
            expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(
              false,
            );
          }
          const calls = getToolExecutions(run).map((event) => ({
            toolName: event.toolName,
            isError: event.isError,
            result: event.result as {
              details: Record<string, unknown>;
              content: { type: string; mimeType?: string; data: string }[];
            },
          }));
          const shell = calls.find((event) => event.toolName === "bash");
          expect(shell?.result.details).toMatchObject({ status: "completed", exitCode: 0 });
          const reads = calls.filter((event) => event.toolName === "read");
          expect(reads).toHaveLength(2);
          for (const [index, event] of reads.entries()) {
            expect(event.isError).toBe(false);
            expect(event.result.details).toMatchObject({
              source: "shell:visual-screen",
              resolvedBy: "terminal",
              mode: index === 0 ? "image" : "sequence",
              frames: index === 0 ? 1 : 3,
            });
            expect(event.result.details).not.toHaveProperty("ignoredViews");
            expect(event.result.details).not.toHaveProperty("viewWarnings");
            const images = event.result.content.filter((block) => block.type === "image");
            expect(images).toHaveLength(index === 0 ? 1 : 3);
            for (const block of images) {
              expect(block).toMatchObject({ mimeType: "image/png" });
              expect(Buffer.from(block.data, "base64").subarray(0, 8)).toEqual(
                Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
              );
            }
          }
          if (native) {
            const message = getToolResultMessage(run, "script");
            expect(message.content.filter((block) => block.type === "image")).toHaveLength(4);
          }
        } finally {
          await rm(cwd, { recursive: true, force: true });
          await fixture?.stop();
        }
      },
    );
  }
}

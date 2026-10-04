import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolExecution,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";

const root = process.cwd();
const temporary = path.join(root, ".tmp/jev-integration");
afterAll(() => rm(temporary, { recursive: true, force: true }));

test.each([
  "enabled",
  "batch",
  "disabled",
  "capture-only",
  "disconnected",
  "empty",
  "absent",
  "malformed",
  "failure",
])("real Pi preserves edits and optional background feedback: %s", async (mode) => {
  await mkdir(temporary, { recursive: true });
  const cwd = await mkdtemp(path.join(temporary, "case-"));
  const config = path.join(cwd, ".pi/pi-agent-ide");
  await mkdir(config, { recursive: true });
  await writeFile(path.join(cwd, "review-case.json"), JSON.stringify({ mode }));
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({
      codemode: { mode: "on" },
    }),
  );
  await writeFile(
    path.join(config, "extensions.json"),
    JSON.stringify({
      preset: "text-editor",
      disabled: ["ide.ast"],
      flags: {
        "pi-agent-ide-code-review": !["disabled", "capture-only"].includes(mode),
        "pi-agent-ide-code-review-capture": mode === "capture-only",
        "pi-agent-ide-no-animations": true,
      },
    }),
  );
  if (mode !== "absent")
    await writeFile(
      path.join(config, "code-review.yaml"),
      mode === "empty"
        ? "rules: []"
        : mode === "malformed"
          ? "rules: nope"
          : "rules:\n  - id: hidden-errors\n    description: Do not hide operation failures.\n",
    );
  await writeFile(path.join(cwd, "file.ts"), "throw error;\n");

  const result = await new PiIntegrationTest({
    testName: `jev-${mode}`,
    cwd,
    extensions: [
      path.join(root, "src/pi-agent-ide.ts"),
      ...(mode === "batch" ? ["builtin:codemode"] : []),
      path.join(root, "tests/integration/code-review/fixture.ts"),
    ],
    skills: [path.join(root, "skills/capture-code-review-rule/SKILL.md")],
    tools: ["write", "wait_review", ...(mode === "batch" ? ["codemode"] : [])],
    rawMode: false,
    isolateUserResources: true,
    environment: {
      // The harness otherwise copies real credentials even with isolateUserResources.
      PI_CODING_AGENT_DIR: path.join(cwd, ".pi"),
      TYPESAFE_API_KEY: "",
      OPENROUTER_API_KEY: "",
      AI_GATEWAY_API_KEY: "",
      OPENCODE_API_KEY: "",
      CLOUDFLARE_API_KEY: "",
    },
    artifactsDir: testArtifactsDir(import.meta.filename),
    conversation: [
      assistantMessage(
        [
          toolCall({
            id: "edit",
            name: mode === "batch" ? "codemode" : "write",
            arguments:
              mode === "batch"
                ? {
                    code: `text(await tools.read({path:"file.ts"})); text(await tools.write({path:"file.ts",content:"return null;\\n"}));`,
                  }
                : { path: "file.ts", content: "return null;\n" },
          }),
        ],
        { stopReason: "toolUse" },
      ),
      assistantMessage([toolCall({ id: "wait", name: "wait_review", arguments: {} })], {
        stopReason: "toolUse",
      }),
      assistantMessage([text("Finished.")]),
    ],
  }).run("Make the edit and wait for optional review feedback.");

  expect(getToolExecution(result, "edit").isError).toBe(false);
  expect(await readFile(path.join(cwd, "file.ts"), "utf8")).toBe("return null;\n");
  const calls = await readFile(path.join(cwd, "review-calls.jsonl"), "utf8").catch(() => "");
  const messages = JSON.stringify(
    result.traceEvents.filter(
      (event) => event.type === "message_end" || event.type === "session_snapshot",
    ),
  );
  if (["enabled", "batch", "failure"].includes(mode)) {
    expect(calls).toContain("+return null;");
    expect(calls).toContain("-throw error;");
    expect(calls.trim().split("\n")).toHaveLength(1);
  } else expect(calls).toBe("");
  if (mode === "enabled" || mode === "batch") {
    expect(messages).toContain("ide-code-review");
    expect(messages).toContain("hidden-errors (95%)");
    expect(messages).toContain("Inspected diff");
    const screen = await readFile(result.artifacts.directory + "/tui-rendered.log", "utf8");
    expect(screen).toContain("Jev code review:");
  } else if (mode === "failure") {
    expect(messages).toContain("Fixture provider failed");
    expect(messages).toContain("This is not a clean review.");
  } else if (mode === "malformed") {
    expect(messages).toContain("Cannot load");
  } else {
    expect(messages).not.toContain("ide-code-review");
  }
  const prompt = getProviderSystemPrompt(result);
  expect(prompt).toContain("reusable code-review requirement into a proposed project Jev rule.");
  if (mode === "capture-only") {
    expect(prompt).toContain("Jev rule capture: enabled");
    expect(prompt).toContain("capture-code-review-rule");
  } else expect(prompt).not.toContain("Jev rule capture: enabled");
});

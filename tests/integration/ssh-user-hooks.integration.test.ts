import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.js";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import {
  SSH_HOOK_TEXT_FILES,
  SSH_HOOK_FORMATTERS,
} from "#integration/fixtures/ssh-hook-content.js";
import { SshBackend } from "#src/backend/ssh.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test("trusted hooks guard remote read paths and mixed moves, then see final native formatting", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-user-hook-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const root = `ssh://fixture${fixture.workspace}`;
  const secret = `${root}/secret.json`;
  const typed = `${root}/secret.ts`;
  const locked = `${root}/locked.txt`;
  const review = `${root}/review.fixture`;
  const failed = `${root}/after.fixture`;
  const copiedText = `${root}/copied.fixture`;
  const copySource = path.join(cwd, "copy-source.fixture");
  const local = path.join(cwd, "move-source.txt");
  try {
    for (const [name, content] of SSH_HOOK_TEXT_FILES)
      await backend.write(`${fixture.workspace}/${name}`, Buffer.from(content), null);
    await backend.write(
      `${fixture.workspace}/.pi/pi-agent-ide/formatters.json`,
      Buffer.from(JSON.stringify(SSH_HOOK_FORMATTERS)),
      null,
    );
    await writeFile(local, "local café source\n");
    await writeFile(copySource, "review copied café\n");
    await backend.write(
      `${fixture.workspace}/copied.fixture`,
      Buffer.from("prior destination café\n"),
      null,
    );
    const binary = Buffer.from([0, 255, 128, 10]);
    await writeFile(path.join(cwd, "source.bin"), binary);
    await backend.write(`${fixture.workspace}/target.bin`, Buffer.from([1, 253]), null);
    await writeFile(path.join(cwd, "secret.json"), "Allowed local café content\n");
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [backend.target] }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: false,
        disabled: [
          "ide.lsp",
          "ide.lint",
          "ide.diagnostics",
          "ide.changes",
          "ide.debugger",
          "ide.terminal",
          "ide.vision",
        ],
      }),
    );
    const calls = [
      { id: "ordinary", name: "read", arguments: { path: secret } },
      { id: "raw", name: "read", arguments: { path: `raw:${secret}`, limit: 32 } },
      { id: "derived", name: "read", arguments: { path: secret, views: ["jq:.message"] } },
      { id: "typed", name: "read", arguments: { path: `ast:${typed}` } },
      {
        id: "script",
        name: "codemode",
        arguments: { code: `text(await tools.read({path:${JSON.stringify(secret)}}));` },
      },

      { id: "throw", name: "read", arguments: { path: `${root}/throw.txt` } },
      { id: "local", name: "read", arguments: { path: "secret.json" } },
      { id: "mixed", name: "move", arguments: { path: local, target: locked, overwrite: true } },

      {
        id: "code-mixed",
        name: "codemode",
        arguments: {
          code: `text(await tools.move({path:${JSON.stringify(local)},target:${JSON.stringify(locked)},overwrite:true}));`,
        },
      },
      {
        id: "binary-copy",
        name: "copy",
        arguments: {
          path: path.join(cwd, "source.bin"),
          target: `${root}/target.bin`,
          overwrite: true,
        },
      },
      {
        id: "formatted-copy",
        name: "copy",
        arguments: { path: copySource, target: copiedText, overwrite: true },
      },
      { id: "review", name: "write", arguments: { path: review, content: "review café\n" } },
      { id: "after-fail", name: "write", arguments: { path: failed, content: "explode café\n" } },
    ];
    const run = await new PiIntegrationTest({
      testName: "ssh-trusted-user-hooks",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/ssh-user-hooks-extension.ts"),
        "builtin:codemode",
      ],
      tools: ["read", "move", "copy", "write", "codemode"],
      timeoutMs: 60_000,
      conversation: [
        ...calls.map((call) => assistantMessage([toolCall(call)])),
        assistantMessage([text("Trusted local hooks checked the exact remote owners.")]),
      ],
    }).run("Check remote guards, mixed move preflight and saved native formatter feedback.");
    for (const id of ["ordinary", "raw", "derived", "typed"]) {
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(true);
      expect(getToolResultText(run, id)).toContain("Owned remote content is blocked");
      expect(getToolResultText(run, id)).not.toContain("PRIVATE_OWNED_READ_CONTENT");
    }
    expect(getToolResultText(run, "script")).toContain("Owned remote content is blocked");
    expect(getToolResultText(run, "script")).not.toContain("PRIVATE_OWNED_READ_CONTENT");
    expect(getToolExecution(run, "throw").isError).toBe(true);
    expect(getToolResultText(run, "throw")).toContain("Owned read hook refused");
    expect(getToolResultText(run, "throw")).not.toContain("PRIVATE_OWNED_READ_CONTENT");
    expect(getToolExecution(run, "local").isError).toBe(false);
    expect(getToolResultText(run, "local")).toContain("Allowed local café content");
    expect(getToolResultText(run, "mixed")).toContain("Owned remote destination is locked");
    expect(getToolResultText(run, "code-mixed")).toContain("Owned remote destination is locked");
    expect(getToolExecution(run, "binary-copy").isError).toBe(false);
    expect((await backend.read(`${fixture.workspace}/target.bin`)).bytes).toEqual(binary);
    expect(await readFile(path.join(cwd, "source.bin"))).toEqual(binary);
    expect(await readFile(local, "utf8")).toBe("local café source\n");
    expect((await backend.read(`${fixture.workspace}/locked.txt`)).bytes.toString("utf8")).toBe(
      "remote café destination\n",
    );
    expect(getToolExecution(run, "review").isError).toBe(false);
    expect(getToolResultText(run, "review")).toContain("Owned review sees final REVIEW CAFÉ");
    expect(run.tuiRenderedOutput).toContain("Owned review sees final REVIEW CAFÉ");
    expect((await backend.read(`${fixture.workspace}/review.fixture`)).bytes.toString("utf8")).toBe(
      "REVIEW CAFÉ\n",
    );
    expect(getToolExecution(run, "after-fail").isError).toBe(false);
    expect(getToolResultText(run, "after-fail")).toContain("failed after the edit was saved");
    expect((await backend.read(`${fixture.workspace}/after.fixture`)).bytes.toString("utf8")).toBe(
      "EXPLODE CAFÉ\n",
    );
    expect(getToolExecution(run, "formatted-copy").isError).toBe(false);
    expect(getToolResultText(run, "formatted-copy")).toContain(
      "Owned review sees final REVIEW COPIED CAFÉ",
    );
    expect((await backend.read(`${fixture.workspace}/copied.fixture`)).bytes.toString("utf8")).toBe(
      "REVIEW COPIED CAFÉ\n",
    );
    const events = (await readFile(path.join(cwd, ".tmp/hook-events.jsonl"), "utf8")).split("\n");
    const copiedAfter = events.find(
      (line) => line.includes('"kind":"afterEdit"') && line.includes(JSON.stringify(copiedText)),
    );
    expect(copiedAfter).toContain(JSON.stringify("prior destination café\n"));
    expect(copiedAfter).toContain(JSON.stringify("REVIEW COPIED CAFÉ\n"));
    expect(run.tuiRenderedOutput).toContain("Owned review sees final REVIEW COPIED CAFÉ");
    expect(
      events.some((line) => line.includes('"binary":{"before":[1,253],"after":[0,255,128,10]}')),
    ).toBe(true);
    const plan = events.find(
      (line) => line.includes('"kind":"beforeEdit"') && line.includes(JSON.stringify(locked)),
    );
    expect(plan).toBeDefined();
    expect(plan).toContain(JSON.stringify(local));
    expect(plan).toContain(JSON.stringify("local café source\n"));
    expect(plan).toContain(JSON.stringify("remote café destination\n"));
    expect(
      events.some(
        (line) =>
          line.includes('"kind":"beforeRead"') &&
          line.includes(JSON.stringify(secret)) &&
          line.includes('"audience":"script"'),
      ),
    ).toBe(true);
    expect(
      events.some(
        (line) =>
          line.includes('"kind":"afterEdit"') &&
          line.includes(JSON.stringify(review)) &&
          line.includes('"after":"REVIEW CAFÉ\\n"'),
      ),
    ).toBe(true);
    expect(
      events
        .filter((line) => line.includes('"kind":"afterEdit"'))
        .every((line) => !line.includes(JSON.stringify(locked))),
    ).toBe(true);
  } finally {
    try {
      await fixture.stop();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}, 70_000);

test("scripted whole-file copies report the prior destination and final formatted hook feedback", async () => {
  const fixture = await startSshFixture();
  const base = path.resolve(".tmp/ssh-user-hook-tests");
  await mkdir(base, { recursive: true });
  const cwd = await mkdtemp(path.join(base, "workspace-"));
  const backend = new SshBackend({
    id: "fixture",
    host: "fixture",
    workspace: fixture.workspace,
    configFile: fixture.config,
  });
  const root = `ssh://fixture${fixture.workspace}`;
  const local = path.join(cwd, "source.fixture");
  try {
    await writeFile(local, "review script café\n");
    await backend.write(
      `${fixture.workspace}/.pi/pi-agent-ide/formatters.json`,
      Buffer.from(JSON.stringify(SSH_HOOK_FORMATTERS)),
      null,
    );
    for (const name of ["ordinary.fixture", "code.fixture"])
      await backend.write(
        `${fixture.workspace}/${name}`,
        Buffer.from(`prior ${name} café\n`),
        null,
      );
    await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
      JSON.stringify({ targets: [backend.target] }),
    );
    await writeFile(
      path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
      JSON.stringify({
        noAnimations: true,
        noPostProcessing: false,
        disabled: [
          "ide.lsp",
          "ide.lint",
          "ide.diagnostics",
          "ide.changes",
          "ide.debugger",
          "ide.terminal",
          "ide.vision",
        ],
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "ssh-scripted-copy-hooks",
      artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
      cwd,
      rawMode: false,
      isolateUserResources: true,
      extensions: [
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/ssh-user-hooks-extension.ts"),
        "builtin:codemode",
      ],
      tools: ["codemode", "copy"],
      timeoutMs: 60_000,
      conversation: [
        assistantMessage([
          toolCall({
            id: "ordinary-copy",
            name: "copy",
            arguments: { path: local, target: `${root}/ordinary.fixture`, overwrite: true },
          }),
        ]),
        assistantMessage([
          toolCall({
            id: "code-copy",
            name: "codemode",
            arguments: {
              code: `text(await tools.copy({path:${JSON.stringify(local)},target:${JSON.stringify(`${root}/code.fixture`)},overwrite:true}));`,
            },
          }),
        ]),
        assistantMessage([text("Checked both saved destinations.")]),
      ],
    }).run(
      "Copy the owned fixture through standalone and native calls and report final saved feedback.",
    );
    const events = (await readFile(path.join(cwd, ".tmp/hook-events.jsonl"), "utf8")).split("\n");
    for (const [id, name] of [
      ["ordinary-copy", "ordinary.fixture"],
      ["code-copy", "code.fixture"],
    ] as const) {
      expect(getToolExecution(run, id).isError).toBe(false);
      expect(getToolResultText(run, id)).toContain("Owned review sees final REVIEW SCRIPT CAFÉ");
      expect((await backend.read(`${fixture.workspace}/${name}`)).bytes.toString("utf8")).toBe(
        "REVIEW SCRIPT CAFÉ\n",
      );
      const event = events.find(
        (line) =>
          line.includes('"kind":"afterEdit"') && line.includes(JSON.stringify(`${root}/${name}`)),
      );
      expect(event).toContain(JSON.stringify(`prior ${name} café\n`));
      expect(event).toContain(JSON.stringify("REVIEW SCRIPT CAFÉ\n"));
    }
    expect(run.tuiRenderedOutput).toContain("Owned review sees final REVIEW SCRIPT CAFÉ");
    expect(await readFile(local, "utf8")).toBe("review script café\n");
  } finally {
    try {
      await fixture.stop();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}, 70_000);

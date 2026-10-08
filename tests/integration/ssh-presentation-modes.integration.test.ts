import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { SshBackend } from "#src/backend/ssh.js";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

test.each([false, true])(
  "startup leaves unused targets untouched with SSH disabled=%s",
  async (disabled) => {
    const base = path.resolve(".tmp/ssh-presentation-tests");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "startup-"));
    try {
      const config = path.join(cwd, ".pi/pi-agent-ide");
      await mkdir(config, { recursive: true });
      const marker = path.join(cwd, "unused-target-contacted");
      const proxy = path.join(cwd, "unused-proxy.py");
      await writeFile(
        proxy,
        `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('contacted')\nraise SystemExit(1)\n`,
      );
      const configFile = path.join(cwd, "unused-ssh-config");
      await writeFile(
        configFile,
        `Host unused\n  HostName unused.invalid\n  ProxyCommand /usr/bin/python3 ${proxy}\n`,
      );
      await writeFile(
        path.join(config, "ssh.json"),
        JSON.stringify({
          targets: [{ id: "unused", host: "unused", workspace: "/owned-unused", configFile }],
        }),
      );
      await writeFile(
        path.join(config, "extensions.json"),
        JSON.stringify({ disabled: disabled ? ["read.ssh"] : [] }),
      );
      await writeFile(path.join(cwd, "note.txt"), "Local café remains available\n");
      const run = await new PiIntegrationTest({
        testName: `ssh-unused-startup-${disabled}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts")],
        tools: ["read", "search"],
        timeoutMs: 60000,
        conversation: [
          assistantMessage([
            toolCall({ id: "local", name: "read", arguments: { path: "note.txt" } }),
          ]),
          assistantMessage([
            toolCall({
              id: "local-search",
              name: "search",
              arguments: { path: "note.txt", query: "café" },
            }),
          ]),
          assistantMessage([text("Local tools did not contact the unused SSH target.")]),
        ],
      }).run("Start all permitted built-ins and use only local source tools.");
      expect(getToolExecution(run, "local").isError).toBe(false);
      expect(getToolResultText(run, "local")).toContain("Local café remains available");
      expect(getToolExecution(run, "local-search").isError).toBe(false);
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  90000,
);

// Presentation must not change execution, source identity or independent publication.
test.each(["full", "compact", "disabled"] as const)(
  "%s presentation keeps remote identities and concurrent disjoint mutation results",
  async (mode) => {
    const fixture = await startSshFixture();
    const base = path.resolve(".tmp/ssh-presentation-tests");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    const backend = new SshBackend({
      id: "fixture",
      host: "fixture",
      workspace: fixture.workspace,
      configFile: fixture.config,
    });
    const remote = `ssh://fixture${fixture.workspace}/note.txt`;
    const remotePeer = `ssh://fixture${fixture.workspace}/peer.txt`;
    const local = path.join(cwd, "note.txt");
    const localPeer = path.join(cwd, "peer.txt");
    try {
      await Promise.all([
        backend.write(`${fixture.workspace}/note.txt`, Buffer.from("remote café TODO\r\n"), null),
        backend.write(`${fixture.workspace}/peer.txt`, Buffer.from("remote peer TODO\r\n"), null),
        writeFile(local, "local café TODO\r\n"),
        writeFile(localPeer, "local peer TODO\r\n"),
      ]);
      const config = path.join(cwd, ".pi/pi-agent-ide");
      await mkdir(config, { recursive: true });
      const marker = path.join(cwd, "unused-target-contacted");
      const proxy = path.join(cwd, "unused-proxy.py");
      await writeFile(
        proxy,
        `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text('contacted')\nraise SystemExit(1)\n`,
      );
      const unusedConfig = path.join(cwd, "unused-ssh-config");
      await writeFile(
        unusedConfig,
        `Host unused\n  HostName unused.invalid\n  ProxyCommand /usr/bin/python3 ${proxy}\n`,
      );
      await writeFile(
        path.join(config, "ssh.json"),
        JSON.stringify({
          targets: [
            backend.target,
            { id: "unused", host: "unused", workspace: "/owned-unused", configFile: unusedConfig },
          ],
        }),
      );
      await writeFile(
        path.join(config, "extensions.json"),
        JSON.stringify({
          noAnimations: true,
          noPostProcessing: true,
          disabled: [
            "ide.lsp",
            "ide.lint",
            "ide.formatter",
            "ide.debugger",
            "ide.terminal",
            "ide.vision",
            "ide.diagnostics",
          ],
          preferences: {
            "ui.read": mode,
            "ui.search": mode,
            "ui.diffs": mode,
            "ui.applyPreview": mode,
          },
        }),
      );
      const run = await new PiIntegrationTest({
        testName: `ssh-presentation-${mode}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "search", "replace", "diff", "codemode"],
        timeoutMs: 90000,
        conversation: [
          assistantMessage([toolCall({ id: "remote", name: "read", arguments: { path: remote } })]),
          assistantMessage([
            toolCall({ id: "matches", name: "search", arguments: { path: remote, query: "café" } }),
          ]),
          assistantMessage([
            toolCall({
              id: "unknown",
              name: "read",
              arguments: { path: "ssh://not-configured/owned/note.txt" },
            }),
          ]),
          assistantMessage([
            toolCall({
              id: "concurrent",
              name: "codemode",
              arguments: {
                code: `
const sources = ${JSON.stringify([local, localPeer, remote, remotePeer])};
const outcomes = await Promise.allSettled(sources.map(path => tools.replace({path,start:"TODO",text:"READY"})));
for (const outcome of outcomes) {
  if (outcome.status !== "fulfilled" || outcome.value.status !== "success") throw Error(JSON.stringify(outcome));
  text(outcome.value);
}
const committed = await tools.flush({});
if (committed.status !== "success") throw Error(JSON.stringify(committed));
text(committed);
for (const outcome of outcomes) {
  if (outcome.status !== "fulfilled") throw Error("Missing mutation result");
  const found = await tools.search({path:outcome.value,query:"READY"});
  if (found.status !== "success" || found.data.matches.length !== 1) throw Error(JSON.stringify(found));
  text(found);
}
`,
              },
            }),
          ]),
          assistantMessage([
            toolCall({ id: "compare", name: "diff", arguments: { before: local, after: remote } }),
          ]),
          assistantMessage([text("Canonical sources and saved results stayed separate.")]),
        ],
      }).run(
        "Check the configured presentation without changing tool execution or probing unused targets.",
      );
      for (const id of ["remote", "matches", "concurrent", "compare"]) {
        expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      }
      expect(getToolResultText(run, "remote")).toContain("remote café TODO");
      expect(getToolResultText(run, "matches")).toContain(remote);
      expect(getToolExecution(run, "unknown").isError).toBe(true);
      expect(getToolResultText(run, "unknown")).toContain("UNKNOWN_TARGET");
      expect(getToolResultText(run, "compare")).toContain(remote);
      expect(getToolResultText(run, "concurrent")).toContain("READY");
      expect(await readFile(local, "utf8")).toBe("local café READY\r\n");
      expect(await readFile(localPeer, "utf8")).toBe("local peer READY\r\n");
      expect((await backend.read(`${fixture.workspace}/note.txt`)).bytes.toString("utf8")).toBe(
        "remote café READY\r\n",
      );
      expect((await backend.read(`${fixture.workspace}/peer.txt`)).bytes.toString("utf8")).toBe(
        "remote peer READY\r\n",
      );
      await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(run.tuiRenderedOutput).toContain(remote);
      expect(run.tuiRenderedOutput).not.toContain(`file://${remote}`);
    } finally {
      await fixture.stop();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  120000,
);

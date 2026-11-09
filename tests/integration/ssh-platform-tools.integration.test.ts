import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import {
  selectedDirections,
  sourcePlatform,
  startTargetFixture,
} from "#integration/support/ssh-target-fixture.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

/** Every formatting status reported anywhere in a tool result's details. */
function formattingStatuses(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  const own =
    "formatting" in value &&
    typeof value.formatting === "object" &&
    value.formatting !== null &&
    "status" in value.formatting &&
    typeof value.formatting.status === "string"
      ? [value.formatting.status]
      : [];
  return [...own, ...Object.values(value).flatMap(formattingStatuses)];
}

/** The terminal output section of a shell tool result, line by line; empty output has none. */
function outputLines(result: string): string[] {
  const marker = result.indexOf("\noutput:");
  if (marker < 0) return [];
  const [first = "", ...rest] = result
    .slice(marker + "\noutput:".length)
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trimEnd());
  return first.trim() === "(empty)" ? [] : rest;
}

/** Whether the target has a file; the fixture's read fails for a missing one. */
const exists = (read: () => Promise<Buffer>) =>
  read().then(
    () => true,
    () => false,
  );

/**
 * The IDE tools used through real Pi in each Linux/Windows direction: edits with stale-revision
 * refusal, whole-file operations, transfers in both directions, a terminal session with input,
 * and Git changes. The backend contract per direction is ssh-platform-matrix.
 */
describe.each(selectedDirections())("IDE tools over SSH, %s", (direction) => {
  const windows = direction.endsWith(">windows");
  const shell =
    sourcePlatform === (windows ? "windows" : "linux")
      ? windows
        ? "powershell"
        : "bash"
      : windows
        ? "remote_powershell"
        : "remote_bash";
  const commands = windows
    ? {
        modify: '[IO.File]::WriteAllText("$PWD\\stale.txt", "changed`n")',
        lines: "Get-Location; 'one'; ''; ''; 'four'",
        greet: "$n = Read-Host 'name'; \"hello-$n\"",
        pause: "Start-Sleep 3",
        autocrlf: "true",
      }
    : {
        modify: "printf 'changed\\n' > stale.txt",
        lines: "printf 'Path\\n----\\n%s\\none\\n\\n\\nfour\\n' \"$PWD\"",
        greet: 'read -r n; echo "hello-$n"',
        pause: "sleep 3",
        autocrlf: "false",
      };

  test("edits, file operations, transfers, terminal input and Git changes", async () => {
    const fixture = await startTargetFixture(windows ? "windows" : "linux");
    const base = path.resolve(".tmp/ssh-platform-tools");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    const root = `ssh://${fixture.target.id}${fixture.workspace}`;
    const binary = Buffer.from([0, 255, 13, 10, 10, 13, 239, 187, 191]);
    try {
      await fixture.put("stale.txt", "one\n");
      await fixture.put("doomed.txt", "remove me\n");
      await writeFile(path.join(cwd, "up.bin"), binary);
      await mkdir(path.join(cwd, "tree/inner"), { recursive: true });
      await writeFile(path.join(cwd, "tree/inner/leaf.txt"), "leaf\r\n");
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
        JSON.stringify({ targets: [fixture.target] }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({
          // Post-edit processing stays on: a save looks for the target's formatter.
          noAnimations: true,
          disabled: ["ide.ast", "ide.lsp", "ide.lint", "ide.debugger", "ide.diagnostics"],
        }),
      );
      const call = (id: string, name: string, args: Record<string, unknown>) =>
        assistantMessage([toolCall({ id, name, arguments: args })]);
      const run = await new PiIntegrationTest({
        testName: `ssh-platform-tools-${direction.replace(">", "-to-")}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: [
          "read",
          "search",
          "write",
          "replace",
          "insert",
          "copy",
          "move",
          "delete",
          "undo",
          "stage",
          shell,
          "codemode",
        ],
        // Each tool call costs several SSH round trips; a Windows login adds seconds to each.
        timeoutMs: 1_500_000,
        conversation: [
          call("write", "write", { path: `${root}/note.txt`, content: "alpha\r\nbeta\r\n" }),
          call("lines", shell, { command: commands.lines, cwd: root }),
          call("files", "codemode", {
            code: `
const root = ${JSON.stringify(root)};
const local = ${JSON.stringify(cwd)};
const shell = tools[${JSON.stringify(shell)}];
const note = await tools.read({ path: root + "/note.txt" });
await tools.replace({ path: (await tools.search({ path: note, query: "beta" })).result, text: "gamma" });
// A change made outside the IDE after the read refuses the edit.
const stale = await tools.read({ path: root + "/stale.txt" });
await shell({ command: ${JSON.stringify(commands.modify)}, cwd: root });
let refused = false;
try {
  await tools.replace({ path: (await tools.search({ path: stale, query: "one" })).result, text: "two" });
} catch { refused = true; }
if (!refused) throw Error("A stale edit was applied");
await tools.copy({ path: root + "/note.txt", target: root + "/copy.txt" });
await tools.move({ path: root + "/copy.txt", target: root + "/moved.txt" });
await tools.delete({ path: root + "/doomed.txt" });
await tools.copy({ path: local + "/up.bin", target: root + "/up.bin" });
await tools.copy({ path: root + "/up.bin", target: local + "/down.bin" });
await tools.copy({ path: local + "/tree", target: root + "/tree" });
await tools.copy({ path: root + "/tree", target: local + "/tree-back" });
text("files done");
`,
          }),
          call("terminal", "codemode", {
            code: `
const shell = tools[${JSON.stringify(shell)}];
const started = String(await shell({ command: ${JSON.stringify(commands.greet)}, cwd: ${JSON.stringify(root)}, background: true }));
const session = started.match(/shell:[0-9a-f]{12}/)?.[0];
if (!session) throw Error("No terminal session: " + started);
await shell({ command: ${JSON.stringify(commands.pause)}, cwd: ${JSON.stringify(root)} });
await tools.write({ path: session, content: "verifier" });
await tools.insert({ path: session, text: "Enter" });
await shell({ command: ${JSON.stringify(commands.pause)}, cwd: ${JSON.stringify(root)} });
text(String(await tools.read({ path: session })));
`,
          }),
          call("git", "codemode", {
            code: `
const root = ${JSON.stringify(root)};
const shell = tools[${JSON.stringify(shell)}];
await shell({ command: "git init -q repo; git -C repo config user.email t@example.invalid; git -C repo config user.name t; git -C repo config core.autocrlf ${commands.autocrlf}", cwd: root });
await tools.write({ path: root + "/repo/a.txt", content: "one\\ntwo\\nthree\\n" });
await shell({ command: "git -C repo add -A; git -C repo commit -qm init", cwd: root });
const committed = await tools.read({ path: root + "/repo/a.txt" });
await tools.write({ path: committed, content: "one\\nTWO\\nthree\\n" });
const anchor = (value) => String(value).match(/CHANGE#[0-9A-F]{4,64}/)?.[0];
const change = anchor(await tools.read({ path: root + "/repo/a.txt", views: ["changes"] }));
await tools.stage({ file: root + "/repo/a.txt", change });
text("STAGED:" + String(await shell({ command: "git -C repo diff --cached --name-only", cwd: root })));
const staged = anchor(await tools.read({ path: root + "/repo/a.txt", views: ["changes"] }));
await tools.undo({ file: root + "/repo/a.txt", change: staged });
text("STATUS:" + String(await shell({ command: "git -C repo status --porcelain", cwd: root })));
`,
          }),
          assistantMessage([text("SSH tools finished.")]),
        ],
      }).run(`Use the IDE tools on the ${direction} target.`);

      for (const id of ["write", "lines", "files", "terminal", "git"])
        expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
      // A target without a configured formatter saves without a formatting failure.
      expect(formattingStatuses(getToolResultMessage(run, "write").details)).not.toContain(
        "failed",
      );

      // Terminal text keeps the lines as the screen shows them.
      const lines = outputLines(getToolResultText(run, "lines"));
      expect(lines).toEqual(expect.arrayContaining(["Path", "----", "one", "four"]));
      expect(lines.slice(lines.indexOf("one"), lines.indexOf("four") + 1)).toEqual([
        "one",
        "",
        "",
        "four",
      ]);
      expect(outputLines(getToolResultText(run, "terminal"))).toContain("hello-verifier");

      expect((await fixture.get("note.txt")).toString("latin1")).toBe("alpha\r\ngamma\r\n");
      expect((await fixture.get("moved.txt")).toString("latin1")).toBe("alpha\r\ngamma\r\n");
      expect((await fixture.get("stale.txt")).toString("latin1").trim()).toBe("changed");
      expect(await exists(() => fixture.get("doomed.txt"))).toBe(false);
      expect(await exists(() => fixture.get("copy.txt"))).toBe(false);
      expect(await fixture.get("up.bin")).toEqual(binary);
      expect(await readFile(path.join(cwd, "down.bin"))).toEqual(binary);
      expect(await fixture.get("tree/inner/leaf.txt")).toEqual(Buffer.from("leaf\r\n"));
      expect(await readFile(path.join(cwd, "tree-back/inner/leaf.txt"), "utf8")).toBe("leaf\r\n");

      const git = getToolResultText(run, "git");
      expect(outputLines(git.slice(git.indexOf("STAGED:"), git.indexOf("STATUS:")))).toContain(
        "a.txt",
      );
      expect(outputLines(git.slice(git.indexOf("STATUS:"))).filter((line) => line.trim())).toEqual(
        [],
      );
      expect((await fixture.get("repo/a.txt")).toString("utf8").replaceAll("\r", "")).toBe(
        "one\ntwo\nthree\n",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await fixture.stop();
    }
  }, 1_600_000);
});

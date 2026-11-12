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
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";
import { SshBackend } from "#src/backend/ssh.ts";
import { remotePython } from "#src/backend/ssh-transport.ts";

const restore = forceStandaloneIntegrationFile();
afterAll(restore);

/** Real Windows hosts, as JSON: [{"id":"win","host":"alias","workspace":"C:/Users/name"}].
 * No CI runner has a Windows SSH host, so this runs only where the variable names one.
 */
const configured = process.env.PI_AGENT_IDE_WINDOWS_SSH_TARGETS;
const targets = (configured ? JSON.parse(configured) : []) as {
  id: string;
  host: string;
  workspace: string;
}[];

test.skipIf(targets.length === 0).each(targets)(
  "$id: file tools read, edit, undo, copy, move and delete on a Windows target",
  async ({ id, host, workspace }) => {
    const backend = new SshBackend({ id, host, workspace, os: "windows" });
    const home = backend.target.workspace;
    const remoteDirectory = `${home}/pi-agent-ide-windows-files`;
    const native = remoteDirectory.slice(1).replaceAll("/", "\\");
    const python = async (source: string) =>
      (await backend.execute(remotePython(source), [], home, { timeoutMs: 60000 })).stdout;
    const base = path.resolve(".tmp/ssh-windows-files");
    await mkdir(base, { recursive: true });
    const cwd = await mkdtemp(path.join(base, "workspace-"));
    const root = `ssh://${id}${remoteDirectory}`;
    const original = "alpha\r\nbeta\r\n";
    const binary = Buffer.from([0, 255, 13, 10, 10, 13, 239, 187, 191]);
    try {
      await python(
        `import shutil\nshutil.rmtree(r"${native}", ignore_errors=True)\nprint("clean")`,
      );
      await backend.write(`${remoteDirectory}/note.txt`, Buffer.from(original), null);
      await backend.write(`${remoteDirectory}/undone.txt`, Buffer.from(original), null);
      await backend.write(`${remoteDirectory}/doomed.txt`, Buffer.from("remove me"), null);
      await backend.write(`${remoteDirectory}/locked.txt`, Buffer.from("read-only"), null);
      await python(
        `import os,stat\nos.chmod(r"${native}\\\\locked.txt", stat.S_IREAD)\nprint("readonly")`,
      );
      await writeFile(path.join(cwd, "up.bin"), binary);
      await writeFile(path.join(cwd, "up-move.bin"), binary);
      await mkdir(path.join(cwd, "tree/inner"), { recursive: true });
      await writeFile(path.join(cwd, "tree/inner/leaf.txt"), "leaf\r\n");
      await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/ssh.json"),
        JSON.stringify({ targets: [backend.target] }),
      );
      await writeFile(
        path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({
          noAnimations: true,
          noPostProcessing: true,
          disabled: [
            "ide.lsp",
            "ide.formatter",
            "ide.lint",
            "ide.debugger",
            "ide.terminal",
            "ide.diagnostics",
          ],
        }),
      );
      const run = await new PiIntegrationTest({
        testName: `ssh-windows-files-${id}`,
        artifactsDir: testArtifactsDir(import.meta.filename, path.resolve(".tmp/test-runs")),
        cwd,
        rawMode: false,
        isolateUserResources: true,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "search", "write", "replace", "delete", "copy", "move", "undo", "codemode"],
        // Every file operation costs several SSH round trips, and a login shell with a heavy
        // profile adds seconds to each.
        timeoutMs: 1800000,
        conversation: [
          assistantMessage([
            toolCall({
              id: "windows-files",
              name: "codemode",
              arguments: {
                code: `
const root = ${JSON.stringify(root)};
const local = ${JSON.stringify(cwd)};
// Edit keeps CRLF, and the undo restores the file as it was.
const note = await tools.read({ path: root + "/note.txt" });
const beta = await tools.search({ path: note, query: "beta" }).then((value) => value.result);
text(await tools.replace({ path: beta, text: "gamma" }));
const undoRead = await tools.read({ path: root + "/undone.txt" });
const written = await tools.write({ path: undoRead, content: "delta\\r\\nbeta\\r\\n" });
const saved = await tools.read({ path: written });
text(await tools.undo({ file: saved, change: "last" }));
// A read-only file is refused, not changed: the Write resolves to null and the result lists why.
const target = await tools.read({ path: root + "/locked.txt" });
const refused = (await tools.write({ path: target, content: "overwritten" })) === null;
if (!refused) throw Error("Read-only file was not refused");
text({ refused });
// Whole-file operations on the target.
text(await tools.copy({ path: root + "/note.txt", target: root + "/copy.txt" }));
text(await tools.move({ path: root + "/copy.txt", target: root + "/moved.txt" }));
text(await tools.move({ path: root + "/moved.txt", target: root + "/MOVED.txt" }));
text(await tools.delete({ path: root + "/doomed.txt" }));
// Transfers in both directions and between a local and a remote tree.
text(await tools.copy({ path: local + "/up.bin", target: root + "/up.bin" }));
text(await tools.move({ path: local + "/up-move.bin", target: root + "/up-move.bin" }));
text(await tools.copy({ path: root + "/up.bin", target: local + "/down.bin" }));
text(await tools.move({ path: root + "/up-move.bin", target: local + "/down-move.bin" }));
text(await tools.copy({ path: local + "/tree", target: root + "/tree" }));
text(await tools.copy({ path: root + "/tree", target: local + "/tree-back" }));
`,
              },
            }),
          ]),
          assistantMessage([text("Windows target file operations finished.")]),
        ],
      }).run("Use the file tools on the Windows target.");
      expect(
        getToolExecution(run, "windows-files").isError,
        getToolResultText(run, "windows-files"),
      ).toBe(false);
      // The read-only file was refused clearly, and nothing else failed.
      const refusal = codemodeFailures(getToolResultText(run, "windows-files"));
      expect(refusal).toMatch(/^1 of \d+ IDE calls failed:\n- write RESULT#\S+\n/u);
      expect(refusal).toContain("FILE_READ_ONLY");
      expect(refusal).toMatch(/no file was written/iu);
      const read = async (name: string) => (await backend.read(`${remoteDirectory}/${name}`)).bytes;
      expect((await read("note.txt")).toString("latin1")).toBe("alpha\r\ngamma\r\n");
      expect((await read("undone.txt")).toString("latin1")).toBe(original);
      expect((await read("locked.txt")).toString("latin1")).toBe("read-only");
      expect((await read("MOVED.txt")).toString("latin1")).toBe("alpha\r\ngamma\r\n");
      const names = (await backend.list(remoteDirectory)).map((entry) => entry.name);
      expect(names).toContain("MOVED.txt");
      expect(names).not.toContain("moved.txt");
      expect(names).not.toContain("copy.txt");
      expect(names).not.toContain("doomed.txt");
      expect(names).not.toContain("up-move.bin");
      expect(await read("up.bin")).toEqual(binary);
      expect(await readFile(path.join(cwd, "down.bin"))).toEqual(binary);
      expect(await readFile(path.join(cwd, "down-move.bin"))).toEqual(binary);
      expect(await read("tree/inner/leaf.txt")).toEqual(Buffer.from("leaf\r\n"));
      expect(await readFile(path.join(cwd, "tree-back/inner/leaf.txt"), "utf8")).toBe("leaf\r\n");
      expect(run.tuiRenderedOutput).toContain(`ssh://${id}/`);
    } finally {
      await python(
        `import shutil,os,stat\np=r"${native}"\nfor r,d,f in os.walk(p):\n  for n in f:\n    try: os.chmod(os.path.join(r,n), stat.S_IWRITE)\n    except OSError: pass\nshutil.rmtree(p, ignore_errors=True)\nprint("cleaned")`,
      ).catch(() => undefined);
      await rm(cwd, { recursive: true, force: true });
    }
  },
  2000000,
);

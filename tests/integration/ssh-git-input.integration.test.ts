import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";

test.each([256 * 1024, 32 * 1024 * 1024])(
  "guarded Git publication keeps exact %i-byte stdin and an outside-workspace native repository",
  async (size) => {
    const fixture = await startSshFixture();
    const registry = new SshBackendRegistry([
      {
        id: "fixture",
        host: "fixture",
        workspace: `${fixture.workspace}/missing-base`,
        configFile: fixture.config,
      },
    ]);
    const owner = registry.resolve(`ssh://fixture${fixture.workspace}`);
    if (!owner) throw new Error("Missing fixture owner");
    const backend = owner.backend;
    try {
      const git = async (...args: string[]) => {
        const result = await backend.execute("/usr/bin/git", args, fixture.workspace);
        expect(result.exitCode, result.stderr.toString("utf8")).toBe(0);
        return result.stdout.toString("utf8").trim();
      };
      await git("init", "--quiet");
      const source = "Owned café before\n";
      await backend.write(`${fixture.workspace}/note.txt`, Buffer.from(source), null);
      await git("add", "--", "note.txt");
      await git(
        "-c",
        "user.name=Owned fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "Owned initial index",
      );
      const prefix = "Changed café \u0000 index\n";
      const text = prefix + "x".repeat(size - Buffer.byteLength(prefix));
      expect(Buffer.byteLength(text)).toBe(size);
      await backend.writeGitIndex(fixture.workspace, {
        repositoryPath: "note.txt",
        mode: "100644",
        text,
        expectedHead: await git("rev-parse", "HEAD"),
        expectedIndexText: source,
        expectedIndexMode: "100644",
        expectedWorktreeText: source,
      });
      expect(await git("cat-file", "-s", ":note.txt")).toBe(String(size));
      const digest = await backend.execute(
        "/usr/bin/python3",
        [
          "-c",
          "import hashlib,subprocess; p=subprocess.Popen(['/usr/bin/git','show',':note.txt'],stdout=subprocess.PIPE); h=hashlib.sha256()\nwhile True:\n b=p.stdout.read(65536)\n if not b: break\n h.update(b)\nassert p.wait()==0\nprint(h.hexdigest())",
        ],
        fixture.workspace,
      );
      expect(digest.exitCode).toBe(0);
      expect(digest.stdout.toString("utf8").trim()).toBe(
        createHash("sha256").update(text).digest("hex"),
      );
      expect((await backend.read(`${fixture.workspace}/note.txt`)).bytes.toString("utf8")).toBe(
        source,
      );
    } finally {
      await fixture.stop();
    }
  },
  60000,
);

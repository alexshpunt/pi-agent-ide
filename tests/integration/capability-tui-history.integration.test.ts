import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { testArtifactsDir } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

interface Receipt {
  execution: { code: number | null; timedOut: boolean };
  reasons: string[];
  events: string;
  providerCallsBefore: string;
  providerCallsAfter: string;
  originalSessionHasResult: boolean;
}

test.skipIf(!existsSync("/usr/bin/script") || !existsSync("/usr/bin/pi")).each([false, true])(
  "native saved-session history preserves tool panels without another provider call (submitted prompt=%s)",
  async (violate) => {
    const artifacts = testArtifactsDir(import.meta.filename);
    await mkdir(artifacts, { recursive: true });
    const root = await mkdtemp(path.join(artifacts, "native-history-"));
    await Promise.all(
      ["state/home", "state/agent", "workspace/fixture"].map((name) =>
        mkdir(path.join(root, name), { recursive: true }),
      ),
    );
    await writeFile(path.join(root, "workspace/fixture/note.txt"), "HISTORY_NATIVE_BODY_MARKER\n");
    const command = [
      process.execPath,
      path.resolve("tests/integration/fixtures/capability-history-launcher.ts"),
      process.cwd(),
      path.resolve(root),
    ]
      .map(quote)
      .join(" ");
    const child = spawn("/usr/bin/script", ["-q", "-e", "-c", command, "/dev/null"], {
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: path.resolve(root, "state/home"),
        TERM: "xterm-256color",
        LANG: "C.UTF-8",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let liveClosed = false;
    let restoredClosed = false;
    const timers: NodeJS.Timeout[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      output += data;
      if (data.includes("\x1b[?u")) child.stdin.write("\x1b[?7u\x1b[?1;2c");
      if (!liveClosed && output.includes("HISTORY_LIVE_SETTLED")) {
        liveClosed = true;
        timers.push(setTimeout(() => child.stdin.write("/quit\r"), 500));
      }
      if (!restoredClosed && output.includes("LPT769_HISTORY_RESTORED")) {
        restoredClosed = true;
        timers.push(
          setTimeout(
            () => child.stdin.write(violate ? "Forbidden second prompt\r" : "/quit\r"),
            500,
          ),
        );
      }
    });
    child.stderr.on("data", (data: string) => {
      output += data;
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      await writeFile(path.join(root, "terminal.log"), output);
      const match = output.match(/CAPABILITY_HISTORY_RESULT (\{[^\r\n]+\})/);
      expect(code, output).toBe(0);
      expect(match, output).not.toBeNull();
      const result = JSON.parse(match?.[1] ?? "null") as Receipt;
      expect(result.providerCallsBefore).toBe("request\nrequest\n");
      expect(result.providerCallsAfter).toBe(result.providerCallsBefore);
      expect(result.originalSessionHasResult).toBe(true);
      const restoredOutput = output.slice(output.indexOf("LPT769_HISTORY_RESTORED"));
      expect(restoredOutput).toContain("HISTORY_NATIVE_BODY_MARKER");
      expect(restoredOutput).toContain("TEXT");
      expect(result.execution).toMatchObject({ code: 0, timedOut: false });
      if (violate) {
        expect(result.reasons).toContain("History inspection attempted agent or provider work");
        expect(result.events).toContain("history_agent_start_refused");
      } else expect(result.reasons).toEqual([]);
    } finally {
      timers.forEach(clearTimeout);
      if (child.exitCode === null) child.kill("SIGTERM");
      await rm(path.join(root, "state"), { recursive: true, force: true });
      await rm(path.join(root, "workspace"), { recursive: true, force: true });
    }
  },
  60000,
);

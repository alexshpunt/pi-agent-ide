import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { testArtifactsDir } from "pi-coding-agent-test";
import { expect, test } from "vitest";

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Track the negotiated input/display modes, not renderer wording. */
function terminalModes(output: string) {
  let kittyDepth = 0;
  let modifyOtherKeys = false;
  const modes = new Map<number, boolean>([
    [7, true],
    [25, true],
  ]);
  // oxlint-disable no-control-regex -- This regression interprets actual terminal control bytes.
  for (const [sequence] of output.matchAll(/\x1b\[[0-9;?<>=]*[a-z]/g)) {
    if (/^\x1b\[>\d+u$/.test(sequence)) kittyDepth += 1;
    const pop = sequence.match(/^\x1b\[<(\d*)u$/);
    if (pop) kittyDepth = Math.max(0, kittyDepth - Number(pop[1] || 1));
    const mode = sequence.match(/^\x1b\[\?(\d+)([hl])$/);
    if (mode) modes.set(Number(mode[1]), mode[2] === "h");
    const modify = sequence.match(/^\x1b\[>4;([0-2])m$/);
    if (modify) modifyOtherKeys = modify[1] !== "0";
  }
  // oxlint-enable no-control-regex
  return {
    kittyDepth,
    modifyOtherKeys,
    bracketedPaste: modes.get(2004) === true,
    alternateScreen: modes.get(1049) === true,
    cursorVisible: modes.get(25) === true,
    lineWrap: modes.get(7) === true,
    mouseOrFocusReporting: [1000, 1002, 1003, 1004, 1006].some((id) => modes.get(id) === true),
    colorReporting: modes.get(2031) === true,
    synchronizedOutput: modes.get(2026) === true,
  };
}

interface Lifecycle {
  result: { code: number | null; signal: string | null; timedOut: boolean };
  before: string;
  after: string;
  shutdown: boolean;
  unexpectedRequest: boolean;
}

async function runLifecycle(mode: "exit" | "ctrl-d" | "timeout") {
  const artifacts = testArtifactsDir(import.meta.filename);
  await mkdir(artifacts, { recursive: true });
  const root = await mkdtemp(path.join(artifacts, `${mode}-`));
  const state = path.join(root, "state");
  await Promise.all(
    ["home", "agent"].map((name) => mkdir(path.join(state, name), { recursive: true })),
  );
  await mkdir(path.join(root, "workspace/fixture"), { recursive: true });
  const command = [
    process.execPath,
    path.resolve("tests/integration/fixtures/capability-terminal-launcher.ts"),
    process.cwd(),
    path.resolve(root),
    mode,
  ]
    .map(quote)
    .join(" ");
  const child = spawn("/usr/bin/script", ["-q", "-e", "-c", command, "/dev/null"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: path.resolve(state, "home"),
      TERM: "xterm-256color",
      LANG: "C.UTF-8",
    },
  });
  let output = "";
  let negotiated = false;
  let submitted = false;
  const timers: NodeJS.Timeout[] = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (data: string) => {
    output += data;
    if (!negotiated && output.includes("\x1b[?u")) {
      negotiated = true;
      child.stdin.write("\x1b[?7u\x1b[?1;2c");
    }
    if (mode !== "timeout" && !submitted && output.includes("CAPABILITY_NATIVE_IDLE_READY")) {
      submitted = true;
      const input = mode === "ctrl-d" ? "\x1b[100;5:1u" : "/quit\r";
      timers.push(setTimeout(() => child.stdin.write(input), 200));
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
    const receipt = output.match(/CAPABILITY_LIFECYCLE_RESULT (\{[^\r\n]+\})/);
    expect(receipt, output).not.toBeNull();
    expect(code, output).toBe(0);
    expect(negotiated).toBe(true);
    return { output, lifecycle: JSON.parse(receipt?.[1] ?? "null") as Lifecycle };
  } finally {
    timers.forEach(clearTimeout);
    if (child.exitCode === null) child.kill("SIGTERM");
    // No authentication was staged. Keep only the terminal evidence, not the fixture workspace.
    await rm(path.join(root, "state"), { recursive: true, force: true });
    await rm(path.join(root, "workspace"), { recursive: true, force: true });
  }
}

test
  .skipIf(!existsSync("/usr/bin/script") || !existsSync("/usr/bin/pi"))
  .each(["exit", "ctrl-d"] as const)(
  "an inherited sandbox terminal performs native shutdown with %s",
  async (mode) => {
    const { output, lifecycle } = await runLifecycle(mode);
    expect(lifecycle.result).toMatchObject({ code: 0, signal: null, timedOut: false });
    expect(lifecycle.shutdown).toBe(true);
    expect(lifecycle.unexpectedRequest).toBe(false);
    expect(lifecycle.after).toBe(lifecycle.before);
    expect(terminalModes(output)).toEqual({
      kittyDepth: 0,
      modifyOtherKeys: false,
      lineWrap: true,
      mouseOrFocusReporting: false,
      colorReporting: false,
      synchronizedOutput: false,
      bracketedPaste: false,
      alternateScreen: false,
      cursorVisible: true,
    });
  },
  60000,
);

test.skipIf(!existsSync("/usr/bin/script") || !existsSync("/usr/bin/pi"))(
  "a forced native TUI timeout restores terminal modes before returning to the launcher",
  async () => {
    const { output, lifecycle } = await runLifecycle("timeout");
    expect(lifecycle.result.timedOut).toBe(true);
    expect(lifecycle.unexpectedRequest).toBe(false);
    expect(lifecycle.after).toBe(lifecycle.before);
    expect(terminalModes(output)).toEqual({
      kittyDepth: 0,
      modifyOtherKeys: false,
      lineWrap: true,
      mouseOrFocusReporting: false,
      colorReporting: false,
      synchronizedOutput: false,
      bracketedPaste: false,
      alternateScreen: false,
      cursorVisible: true,
    });
  },
  60000,
);

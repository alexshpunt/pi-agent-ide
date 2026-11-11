import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { launchCommand, localXdgConfig } from "./clangd-launch.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Run the launcher in a shell with `home`, printing the config clangd would read. */
function launch(home: string, environment: Record<string, string> = {}): string {
  const [shell, ...arguments_] = launchCommand(["clangd"], true);
  // The launched program stands in for clangd and prints the config it would read.
  const show = [
    "sh",
    "-c",
    'printf "%s\\n" "$XDG_CONFIG_HOME"; cat "$XDG_CONFIG_HOME/clangd/config.yaml"',
  ];
  return execFileSync(shell!, [...arguments_.slice(0, -1), ...show], {
    env: { PATH: process.env.PATH, HOME: home, ...environment },
    encoding: "utf8",
  });
}

function home(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "clangd-launch-"));
  homes.push(directory);
  return directory;
}

test("only clangd starts through the launcher, and only where it reads XDG config", () => {
  for (const command of [["clangd"], ["clangd-18", "--log=error"], ["/usr/bin/clangd"]])
    expect(launchCommand(command, true).slice(0, 2)).toEqual(["sh", "-c"]);
  expect(launchCommand(["/usr/bin/clangd-18", "--log=error"], true).slice(3)).toEqual([
    "pi-agent-ide-clangd",
    "/usr/bin/clangd-18",
    "--log=error",
  ]);
  expect(launchCommand(["typescript-language-server", "--stdio"], true)).toEqual([
    "typescript-language-server",
    "--stdio",
  ]);
  expect(launchCommand(["clangd"], false)).toEqual(["clangd"]);
  expect(localXdgConfig("linux")).toBe(true);
  expect(localXdgConfig("darwin")).toBe(false);
  expect(localXdgConfig("win32")).toBe(false);
});

test.skipIf(process.platform === "win32")(
  "the launcher lifts the error limit before the user's own clangd config",
  () => {
    const directory = home();
    mkdirSync(path.join(directory, ".config/clangd"), { recursive: true });
    writeFileSync(
      path.join(directory, ".config/clangd/config.yaml"),
      "CompileFlags:\n  Add: [-ferror-limit=5]\n",
    );
    const [config, ...lines] = launch(directory).trimEnd().split("\n");
    expect(config).toBe(path.join(directory, ".cache/pi-agent-ide/clangd-config"));
    expect(lines.filter((line) => !line.startsWith("#"))).toEqual([
      "CompileFlags:",
      "  Add: [-ferror-limit=0]",
      "---",
      "CompileFlags:",
      "  Add: [-ferror-limit=5]",
    ]);
    // A second start rewrites the same file instead of appending to it.
    launch(directory);
    expect(
      readFileSync(path.join(config!, "clangd/config.yaml"), "utf8").match(/---/gu),
    ).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "without a writable cache the launcher uses a private temporary directory",
  () => {
    const temporary = home();
    // A home that is a file has no cache directory, even for root.
    const file = path.join(temporary, "home-file");
    writeFileSync(file, "");
    const [config, ...lines] = launch(file, { TMPDIR: temporary }).trimEnd().split("\n");
    expect(path.dirname(config!)).toBe(temporary);
    expect(lines).toContain("  Add: [-ferror-limit=0]");
    expect(execFileSync("stat", ["-c", "%a", config!], { encoding: "utf8" }).trim()).toBe("700");
  },
);

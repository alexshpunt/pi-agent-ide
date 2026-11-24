import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const installCommand = "pnpm test:integration:install-browser";
// Playwright resolves this at module load. Keep it scoped to the setup and lookup processes.
const playwrightEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" };

let executablePath: string | undefined;

/** Resolve the Chromium revision installed for this checkout's locked Playwright version. */
export function integrationChromiumPath(): string {
  if (executablePath) return executablePath;
  try {
    const executable = execFileSync(
      process.execPath,
      [
        "-p",
        "require(process.argv[1]).chromium.executablePath()",
        require.resolve("playwright-core"),
      ],
      { encoding: "utf8", env: playwrightEnv, timeout: 5000 },
    ).trim();
    accessSync(executable, constants.X_OK);
    if (process.platform === "linux") {
      execFileSync(executable, ["--version"], { timeout: 5000 });
    }
    executablePath = executable;
    return executable;
  } catch (cause) {
    const systemDeps =
      process.platform === "linux"
        ? " Add --with-deps if Chromium's system libraries are missing."
        : "";
    throw new Error(
      `Integration Chromium is unavailable. Run \`${installCommand}\` from the repository root.${systemDeps}`,
      { cause },
    );
  }
}

if (import.meta.main) {
  const cli = path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
  const result = spawnSync(
    process.execPath,
    [cli, "install", "--no-shell", "chromium", ...process.argv.slice(2)],
    { env: playwrightEnv, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

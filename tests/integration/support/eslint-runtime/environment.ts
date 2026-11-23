import { accessSync, constants } from "node:fs";
import path from "node:path";

const runtimeRoot = import.meta.dirname;
const bin = path.join(runtimeRoot, "node_modules", ".bin");

/** Provision only the Pi scenarios that exercise the real ESLint daemon. */
export function eslintRuntimeEnvironment(): NodeJS.ProcessEnv {
  const executable = path.join(bin, process.platform === "win32" ? "eslint_d.cmd" : "eslint_d");
  try {
    accessSync(executable, constants.X_OK);
    accessSync(path.join(runtimeRoot, "node_modules", "eslint", "package.json"), constants.R_OK);
  } catch (cause) {
    throw new Error(
      "The lint integration tests need the checkout's eslint_d and ESLint. Run `pnpm install --frozen-lockfile` from the repository root.",
      { cause },
    );
  }

  return {
    PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter),
    ESLINT_D_ROOT: runtimeRoot,
    ESLINT_D_MISS: "fail",
    // The daemon must outlive individual lint invocations, but not the test worker.
    ESLINT_D_PPID: String(process.pid),
  };
}

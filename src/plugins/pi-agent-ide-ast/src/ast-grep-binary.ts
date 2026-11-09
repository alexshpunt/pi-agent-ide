import { createRequire } from "node:module";

import { probeExecutable, type ExecutableProbeResult } from "pi-agent-doctor/api/executable";

const require = createRequire(import.meta.url);

/** Name used when no bundled binary exists for this platform and the PATH may provide one. */
const PATH_COMMAND = "ast-grep";

interface AstGrepPackage {
  resolveBinaryPath(): string | null;
}

let bundled: { readonly path: string | undefined } | undefined;

/**
 * The ast-grep executable that ships with this package, or undefined when the platform package
 * is missing (for example musl Linux, or an install without optional dependencies). It resolves
 * the platform binary directly, so it does not depend on the package's postinstall script.
 */
export function bundledAstGrepPath(): string | undefined {
  if (bundled !== undefined) return bundled.path;
  let found: string | undefined;
  try {
    const { resolveBinaryPath } = require("@ast-grep/cli/postinstall.js") as AstGrepPackage;
    found = resolveBinaryPath() ?? undefined;
  } catch {
    // The bundled package could not be loaded; the PATH command is the only candidate.
  }
  bundled = { path: found };
  return found;
}

/** The command that starts ast-grep on this machine: the bundled binary first, then the PATH. */
export function localAstGrepCommand(): string {
  return bundledAstGrepPath() ?? PATH_COMMAND;
}

/** Start `ast-grep --version` to prove that structural search can run on this machine. */
export function probeLocalAstGrep(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<ExecutableProbeResult> {
  return probeExecutable(localAstGrepCommand(), ["--version"], cwd, environment, signal);
}

import path from "node:path";

/** clangd and its versioned names, such as clangd-18, with or without a directory. */
const CLANGD = /^clangd(?:-\d+(?:\.\d+)*)?$/u;

/**
 * Writes a clangd user config that lifts clang's error limit, followed by the user's own config,
 * then starts clangd with it. User config takes precedence over a project's `.clangd` and its
 * compile commands, so the lifted limit applies to every project, while a `-ferror-limit` in the
 * user's own config still wins. The config goes to the user's cache directory, or to a private
 * temporary directory when that is not writable; when neither works, clangd starts unchanged.
 */
const LAUNCHER = [
  'u="${XDG_CONFIG_HOME:-$HOME/.config}/clangd/config.yaml"',
  "write() {",
  '  c="$1/clangd/config.yaml"',
  '  mkdir -p "$1/clangd" && {',
  "    printf '%s\\n' '# Written by pi-agent-ide for the clangd it starts: report every error.' 'CompileFlags:' '  Add: [-ferror-limit=0]'",
  '    if [ -f "$u" ] && [ "$u" != "$c" ]; then printf \'%s\\n\' \'---\'; cat "$u"; fi',
  '  } > "$c.$$" && mv -f "$c.$$" "$c" || { rm -f "$c.$$"; false; }',
  "}",
  'd="${XDG_CACHE_HOME:-$HOME/.cache}/pi-agent-ide/clangd-config"',
  // A home without a writable cache gets a private directory of its own for each start.
  'if write "$d" 2>/dev/null || { d=$(mktemp -d "${TMPDIR:-/tmp}/pi-agent-ide-clangd.XXXXXX") && write "$d"; } 2>/dev/null; then',
  '  XDG_CONFIG_HOME="$d"',
  "  export XDG_CONFIG_HOME",
  "fi",
  'exec "$@"',
].join("\n");

/**
 * The command that starts a language server. After clang's error limit of 20 it stops
 * instantiating templates, so code after the limit loses its references without any error there.
 * clangd has no flag for compile options, so it starts through a POSIX shell that gives it a user
 * config with `-ferror-limit=0`. clangd reads that config from `$XDG_CONFIG_HOME` only on Linux and
 * other non-Apple Unix systems; elsewhere the command stays as configured.
 */
export function launchCommand(command: readonly string[], xdgConfig: boolean): string[] {
  const executable = command[0];
  if (!xdgConfig || executable === undefined || !CLANGD.test(path.posix.basename(executable)))
    return [...command];
  return ["sh", "-c", LAUNCHER, "pi-agent-ide-clangd", ...command];
}

/** Whether a clangd started on this machine reads its user config from `$XDG_CONFIG_HOME`. */
export function localXdgConfig(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32" && platform !== "darwin";
}

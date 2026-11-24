/**
 * Insert a release section below the changelog title, keeping the notes as written. Windows line
 * endings become `\n`: the changelog uses `\n` and the formatter check rejects a file with `\r\n`,
 * which a workflow input typed on Windows or copied from a terminal carries.
 */
export function insertReleaseNotes(changelog: string, heading: string, notes: string): string {
  // A replacement function keeps `$` sequences such as `$$$ARGS` literal.
  return changelog.replace(
    "# Changelog\n",
    () => `# Changelog\n\n${heading}\n\n${notes.replaceAll("\r\n", "\n")}\n`,
  );
}

/** Insert a release section below the changelog title, keeping the notes byte for byte. */
export function insertReleaseNotes(changelog: string, heading: string, notes: string): string {
  // A replacement function keeps `$` sequences such as `$$$ARGS` literal.
  return changelog.replace("# Changelog\n", () => `# Changelog\n\n${heading}\n\n${notes}\n`);
}

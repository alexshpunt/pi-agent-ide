import { expect, it } from "vitest";

import { insertReleaseNotes } from "./changelog.ts";

it("keeps dollar sequences in release notes literal", () => {
  const notes = "- Pass `$NAME`, `$$$ARGS`, `$&` and `$1` captures.";
  expect(insertReleaseNotes("# Changelog\n\n## 0.1.0\n", "## 0.2.0", notes)).toBe(
    `# Changelog\n\n## 0.2.0\n\n${notes}\n\n## 0.1.0\n`,
  );
});
it("writes notes with Windows line endings as the Unix endings the changelog uses", () => {
  const notes = "### Fixed\r\n\r\n- One fix.\r\n- Another fix.";
  expect(insertReleaseNotes("# Changelog\n\n## 0.1.0\n", "## 0.2.0", notes)).toBe(
    "# Changelog\n\n## 0.2.0\n\n### Fixed\n\n- One fix.\n- Another fix.\n\n## 0.1.0\n",
  );
});

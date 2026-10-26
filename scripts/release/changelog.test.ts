import { expect, it } from "vitest";

import { insertReleaseNotes } from "./changelog.ts";

it("keeps dollar sequences in release notes literal", () => {
  const notes = "- Pass `$NAME`, `$$$ARGS`, `$&` and `$1` captures.";
  expect(insertReleaseNotes("# Changelog\n\n## 0.1.0\n", "## 0.2.0", notes)).toBe(
    `# Changelog\n\n## 0.2.0\n\n${notes}\n\n## 0.1.0\n`,
  );
});

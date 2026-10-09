import { expect, test } from "vitest";
import {
  formatCodeViewReference,
  parseCodeViewReference,
  resolveCodeViewPath,
} from "./reference.js";

test("code-view paths retain explicit and cwd-relative SSH identity", () => {
  expect(resolveCodeViewPath("ssh://target/work/note.ts", "/local")).toBe(
    "ssh://target/work/note.ts",
  );
  // oxlint-disable-next-line repo/no-parent-paths -- fixture for remote parent resolution
  expect(resolveCodeViewPath("../notes/café #1.ts", "ssh://target/work/src")).toBe(
    "ssh://target/work/notes/caf%C3%A9%20%231.ts",
  );
  expect(resolveCodeViewPath("/etc/note.ts", "ssh://target/work")).toBe("ssh://target/etc/note.ts");
  const source = "ssh://target/work/caf%C3%A9%20%231.ts";
  expect(() => resolveCodeViewPath("unknown://target/note.ts", "ssh://target/work")).toThrow(
    "Unsupported code-view resource owner",
  );
  expect(parseCodeViewReference(formatCodeViewReference("ast", source), "ast")?.path).toBe(source);
  expect(() => resolveCodeViewPath("unknown://target/note.ts", "/local")).toThrow(
    "Unsupported code-view resource owner",
  );
});

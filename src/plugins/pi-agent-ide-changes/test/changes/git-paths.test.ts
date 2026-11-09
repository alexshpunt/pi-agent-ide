import { expect, test } from "vitest";
import { gitSourceDirectory, relativeGitSource, resolveGitSource } from "#src/changes/git-paths.ts";

const workspace = "ssh://win/C:/Users/name/repo";

test.each([
  ["C:/Users/name/repo", "ssh://win/C:/Users/name/repo"],
  ["c:\\Users\\name\\repo\\sub", "ssh://win/C:/Users/name/repo/sub"],
  ["D:/work", "ssh://win/D:/work"],
  ["sub/file.txt", "ssh://win/C:/Users/name/repo/sub/file.txt"],
])("a Windows Git path %s names its drive on the remote owner", (source, expected) => {
  expect(resolveGitSource(source, workspace)).toBe(expected);
});

test("Windows repository paths stay relative to the repository root", () => {
  const root = resolveGitSource("C:/Users/name/repo", workspace);
  const file = resolveGitSource("src/a b.txt", root);
  expect(relativeGitSource(root, file)).toBe("src/a b.txt");
  expect(gitSourceDirectory("src/a b.txt", root)).toBe("ssh://win/C:/Users/name/repo/src");
});

test("a Windows path never reaches a local resolver", () => {
  expect(resolveGitSource("C:/Users/name/repo", "/srv/work")).not.toContain("ssh://");
});

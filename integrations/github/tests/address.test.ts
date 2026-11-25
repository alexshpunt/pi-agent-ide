import assert from "node:assert/strict";
import { expect, test } from "vitest";
import { parseGithubAddress } from "#github/address.ts";

test("normalizes native URLs and keeps comment identities separate", () => {
  expect(parseGithubAddress("https://github.com/example/project/pull/12")?.source).toBe(
    "github://example/project/pulls/12",
  );
  expect(
    parseGithubAddress("https://github.com/example/project/issues/12#issuecomment-34")?.source,
  ).toBe("github://example/project/issues/comments/34");
  expect(
    parseGithubAddress("https://github.com/example/project/pull/12#discussion_r56")?.source,
  ).toBe("github://example/project/pulls/comments/56");
});

test("routes native milestone links to the numbered API resource", () => {
  expect(parseGithubAddress("https://github.com/example/project/milestone/1")?.source).toBe(
    "github://example/project/milestones/1",
  );
});
test("rejects owned URLs that could escape the repository or send credentials elsewhere", () => {
  for (const source of [
    "github://user:secret@example/project",
    "github://example/project/issues/%2Foutside",
    "github://example/project/unknown",
    "github://example/project?access_token=secret",
  ]) {
    expect(() => parseGithubAddress(source)).toThrow("GH_INVALID_URI");
  }
  expect(parseGithubAddress("https://example.org/example/project/issues/1")).toBeUndefined();
  expect(parseGithubAddress("https://github.com/settings/profile")).toBeUndefined();
});

test("keeps native collection search filters instead of ignoring them", () => {
  const address = parseGithubAddress(
    "https://github.com/example/project/issues?q=is%3Aopen+failure",
  );
  assert.ok(address);
  expect(address.parts).toEqual(["search"]);
  expect(address.parameters.get("kind")).toBe("issues");
  expect(address.parameters.get("q")).toBe("is:open failure");
});
test("requires explicit file ref/path instead of guessing slash-containing Git refs", () => {
  expect(
    parseGithubAddress(
      "github://example/project/file?ref=feature%2Fbranch&path=src%2Findex.ts",
    )?.parameters.get("ref"),
  ).toBe("feature/branch");
  expect(() =>
    parseGithubAddress("https://github.com/example/project/blob/feature/branch/index.ts"),
  ).toThrow("GH_EXPLICIT_FILE_REF_REQUIRED");
});

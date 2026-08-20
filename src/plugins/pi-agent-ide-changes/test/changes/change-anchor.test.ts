import { requiredValue } from "../../../../utils/required-value.js";
import { describe, expect, test } from "vitest";

import {
  CHANGE_ANCHOR_KIND,
  ChangeTextAnchor,
  createChangeAnchorRegistration,
} from "#src/change-anchor.js";
import { createChangeGroups } from "#src/changes/change-groups.js";

import type { GitCommandExecutor, GitCommandResult } from "#src/changes/git-changes-backend.js";
import type { TextAnchorResolverContext } from "pi-agent-text";

const repositoryRoot = "/repo";
const source = "/repo/src/example.ts";
const repositoryPath = "src/example.ts";
const headBlob = "1111111111111111111111111111111111111111";
const indexBlob = "2222222222222222222222222222222222222222";
const headText = [
  "export const first = 1;",
  "export const second = 2;",
  "export const third = 3;",
  "export const fourth = 4;",
  "export const fifth = 5;",
  "export const sixth = 6;",
  "export const seventh = 7;",
  "export const eighth = 8;",
  "export const ninth = 9;",
  "export const tenth = 10;",
  "export const eleventh = 11;",
  "export const twelfth = 12;",
  "",
].join("\n");
const worktreeText = [
  "export const first = 10;",
  "export const second = 2;",
  "export const third = 3;",
  "export const fourth = 4;",
  "export const fifth = 5;",
  "export const sixth = 6;",
  "export const seventh = 7;",
  "export const eighth = 8;",
  "export const ninth = 9;",
  "export const tenth = 10;",
  "export const eleventh = 11;",
  "export const twelfth = 120;",
  "",
].join("\n");

function createExecutor(): GitCommandExecutor {
  return {
    exec(_command, args): Promise<GitCommandResult> {
      const key = args.join(" ");

      if (key === "rev-parse --show-toplevel") {
        return Promise.resolve(success(`${repositoryRoot}\n`));
      }

      if (key === "rev-parse --verify HEAD") {
        return Promise.resolve(success("abc123\n"));
      }

      if (key === `--literal-pathspecs ls-tree -z HEAD -- ${repositoryPath}`) {
        return Promise.resolve(success(`100644 blob ${headBlob}\t${repositoryPath}\0`));
      }

      if (key === `--literal-pathspecs ls-files --stage -z -- ${repositoryPath}`) {
        return Promise.resolve(success(`100644 ${indexBlob} 0\t${repositoryPath}\0`));
      }

      if (key === `cat-file blob ${headBlob}` || key === `cat-file blob ${indexBlob}`) {
        return Promise.resolve(success(headText));
      }

      return Promise.resolve({ code: 1, stdout: "", stderr: `Unexpected git command: ${key}` });
    },
  };
}

function success(stdout: string): GitCommandResult {
  return { code: 0, stdout, stderr: "" };
}

function context(text = worktreeText, currentSource = source): TextAnchorResolverContext {
  return {
    source: currentSource,
    content: text,
    lines: text.split("\n"),
    cwd: repositoryRoot,
  };
}

describe("Git change anchors", () => {
  test("exports an IDE-owned dynamic anchor kind", () => {
    expect(CHANGE_ANCHOR_KIND).toBe("pi-agent-ide-changes/change");
  });

  test("resolves a current selector to its first worktree line", async () => {
    const groups = createChangeGroups(repositoryPath, headText, headText, worktreeText);
    const registration = createChangeAnchorRegistration(createExecutor());
    const result = await registration.resolver.tryResolve(
      requiredValue(groups[1]).selector,
      context(),
    );

    expect(result.kind).toBe("resolved");

    if (result.kind === "resolved") {
      expect(result.anchor).toBeInstanceOf(ChangeTextAnchor);
      expect(result.anchor.value).toBe(requiredValue(groups[1]).selector);
      expect(result.anchor.lineNumber).toBe(requiredValue(groups[1]).currentStartLine);
    }
  });

  test("passes through wrong formats and unsupported resource sources", async () => {
    const registration = createChangeAnchorRegistration(createExecutor());

    await expect(registration.resolver.tryResolve("12#ABCD", context())).resolves.toEqual({
      kind: "not-handled",
    });
    await expect(
      registration.resolver.tryResolve("CHANGE#ABCD", context(worktreeText, "memory://example")),
    ).resolves.toEqual({ kind: "not-handled" });
  });

  test("resolves current selectors and rejects stale ones", async () => {
    const groups = createChangeGroups(repositoryPath, headText, headText, worktreeText);
    const registration = createChangeAnchorRegistration(createExecutor());

    await expect(
      registration.resolver.tryResolve(requiredValue(groups[0]).selector, context()),
    ).resolves.toMatchObject({
      kind: "resolved",
    });
    await expect(registration.resolver.tryResolve("CHANGE#DEADBEEF", context())).resolves.toEqual({
      kind: "rejected",
      rejection: {
        code: "stale",
        reason: "Change anchor CHANGE#DEADBEEF is stale or unknown",
      },
    });
  });
});

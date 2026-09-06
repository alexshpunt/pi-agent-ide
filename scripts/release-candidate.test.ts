import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  verifyCandidate,
  verifyCandidateArchive,
  type CandidateEvidence,
} from "./release-candidate.ts";

const evidence: CandidateEvidence = {
  repository: "alexshpunt/pi-agent-ide",
  pullRequest: 12,
  runId: 34,
  version: "0.3.0",
  headCommit: "head",
  baseCommit: "base",
  tree: "tree",
  sha256: "",
  sha512: "",
};
const expected = { ...evidence, parents: ["base"] };

test("promotes the exact checked tree after a squash merge", () => {
  expect(() => verifyCandidate(evidence, expected)).not.toThrow(Error);
});
test.each(["repository", "pullRequest", "runId", "version", "headCommit", "tree"] as const)(
  "rejects mismatched %s",
  (key) => {
    expect(() => verifyCandidate({ ...evidence, [key]: "other" }, expected)).toThrow(Error);
  },
);
test.each([["stale-base"], ["base", "other-parent"], []])(
  "rejects an untested merge base or merge shape %j",
  (...parents) => {
    expect(() => verifyCandidate(evidence, { ...expected, parents })).toThrow(Error);
  },
);
test("checks archive bytes and identity, including repeat verification", () => {
  const root = path.resolve(".agents/tmp/candidate-contract");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "archive-"));
  try {
    mkdirSync(path.join(directory, "package"));
    writeFileSync(
      path.join(directory, "package/package.json"),
      JSON.stringify({ name: "pi-agent-ide", version: evidence.version }),
    );
    const archive = path.join(directory, `pi-agent-ide-${evidence.version}.tgz`);
    execFileSync("tar", ["-czf", archive, "-C", directory, "package"]);
    const bytes = readFileSync(archive);
    const checked = {
      ...evidence,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
    };
    expect(verifyCandidateArchive(directory, checked)).toBe(archive);
    expect(verifyCandidateArchive(directory, checked)).toBe(archive);
    expect(() => verifyCandidateArchive(directory, { ...checked, sha512: "other" })).toThrow(Error);
    writeFileSync(archive, "changed");
    expect(() => verifyCandidateArchive(directory, checked)).toThrow(Error);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

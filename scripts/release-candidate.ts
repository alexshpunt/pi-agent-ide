import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

/** Evidence recorded by the successful PR validation job. */
export interface CandidateEvidence {
  version: string;
  repository: string;
  pullRequest: number;
  headCommit: string;
  baseCommit: string;
  tree: string;
  runId: number;
  sha256: string;
  sha512: string;
}

/** Rejects promotion unless the tested tree became one squash commit on main. */
export function verifyCandidate(
  evidence: CandidateEvidence,
  expected: {
    repository: string;
    pullRequest: number;
    runId: number;
    headCommit: string;
    version: string;
    tree: string;
    parents: string[];
  },
): void {
  for (const key of [
    "repository",
    "pullRequest",
    "runId",
    "headCommit",
    "version",
    "tree",
  ] as const) {
    if (evidence[key] !== expected[key]) throw new Error(`Candidate ${key} does not match`);
  }
  if (expected.parents.length !== 1 || expected.parents[0] !== evidence.baseCommit) {
    throw new Error("Candidate was not squash merged onto its tested base");
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(evidence.version)) {
    throw new Error("Invalid release version");
  }
}

/** Checks the exact archive bytes and package identity before they can be published. */
export function verifyCandidateArchive(directory: string, evidence: CandidateEvidence): string {
  const filename = `pi-agent-ide-${evidence.version}.tgz`;
  const archives = readdirSync(directory).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1 || archives[0] !== filename)
    throw new Error("Unexpected release archive");
  const file = `${directory}/${filename}`;
  const bytes = readFileSync(file);
  for (const algorithm of ["sha256", "sha512"] as const) {
    if (createHash(algorithm).update(bytes).digest("hex") !== evidence[algorithm]) {
      throw new Error(`Archive ${algorithm} does not match`);
    }
  }
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", file, "package/package.json"], { encoding: "utf8" }),
  ) as { name?: string; version?: string; private?: boolean };
  if (
    manifest.name !== "pi-agent-ide" ||
    manifest.version !== evidence.version ||
    manifest.private === true
  ) {
    throw new Error("Archive package identity does not match");
  }
  return file;
}

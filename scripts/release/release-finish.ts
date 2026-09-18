#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { privateRestorePaths, releasePolicy } from "./policy.ts";
import { createReleaseProgress, hashFile, integrityFile, invariant, output } from "./runtime.ts";
import { findRepositoryRoot } from "#scripts/repository-root.ts";

import { verifyInstalledPackage } from "#scripts/release-candidate.ts";

const repositoryRoot = findRepositoryRoot(import.meta.url);

/** Restores only private release commands while keeping the published package version. */
export function restorePrivateReleaseScripts(
  publicManifestPath: string,
  privateManifestPath: string,
): void {
  const publicManifest: unknown = JSON.parse(readFileSync(publicManifestPath, "utf8"));
  const privateManifest: unknown = JSON.parse(readFileSync(privateManifestPath, "utf8"));
  invariant(
    isManifest(publicManifest) && isManifest(privateManifest),
    "Invalid package manifest while restoring private scripts",
  );
  for (const [name, command] of Object.entries(privateManifest.scripts)) {
    if (name.startsWith("release:")) publicManifest.scripts[name] = command;
  }
  invariant(
    ["release:prepare", "release:finish", "release:verify-public"].every(
      (name) => typeof publicManifest.scripts[name] === "string",
    ),
    "Private release commands were not restored",
  );
  writeFileSync(publicManifestPath, `${JSON.stringify(publicManifest, null, 2)}\n`);
}

function isManifest(value: unknown): value is { scripts: Record<string, unknown> } {
  if (typeof value !== "object" || value === null || !("scripts" in value)) return false;
  const scripts = value.scripts;
  return typeof scripts === "object" && scripts !== null && !Array.isArray(scripts);
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "--") arguments_.shift();
  const [version] = arguments_;
  const progress = createReleaseProgress({ total: 20 });
  invariant(
    version !== undefined && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version),
    "Usage: release:finish <version>",
  );
  const tag = `v${version}`;
  invariant(
    output("git", ["branch", "--show-current"], { cwd: repositoryRoot }) ===
      releasePolicy.privateBranch,
    `Finish must run on ${releasePolicy.privateBranch}`,
  );
  invariant(
    output("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: repositoryRoot }) ===
      "",
    "Tracked worktree must be clean",
  );

  await progress.run(
    "git",
    ["fetch", releasePolicy.publicRemote, releasePolicy.publicBranch, "--tags"],
    {
      cwd: repositoryRoot,
    },
  );
  await progress.run("git", ["fetch", releasePolicy.privateRemote, releasePolicy.privateBranch], {
    cwd: repositoryRoot,
  });
  invariant(
    output("git", ["cat-file", "-t", tag], { cwd: repositoryRoot }) === "tag",
    `${tag} is not an annotated tag`,
  );

  const runJson = output("gh", [
    "run",
    "list",
    "--repo",
    releasePolicy.publicRepository,
    "--workflow",
    releasePolicy.releaseWorkflow,
    "--commit",
    output("git", ["rev-list", "-n", "1", tag], { cwd: repositoryRoot }),
    "--limit",
    "1",
    "--json",
    "databaseId,conclusion",
  ]);
  const runs: unknown = JSON.parse(runJson);
  invariant(Array.isArray(runs) && runs.length === 1, `No release workflow found for ${tag}`);
  const workflow: unknown = runs[0];
  invariant(
    typeof workflow === "object" &&
      workflow !== null &&
      "databaseId" in workflow &&
      typeof workflow.databaseId === "number",
    `Release workflow for ${tag} is missing its run identity`,
  );
  const jobsResult: unknown = JSON.parse(
    output("gh", [
      "run",
      "view",
      String(workflow.databaseId),
      "--repo",
      releasePolicy.publicRepository,
      "--json",
      "jobs",
    ]),
  );
  invariant(
    typeof jobsResult === "object" &&
      jobsResult !== null &&
      "jobs" in jobsResult &&
      Array.isArray(jobsResult.jobs),
    `Release workflow for ${tag} has no job results`,
  );
  const jobs = jobsResult.jobs as readonly unknown[];
  for (const requiredJob of ["Verify candidate", "Publish package"]) {
    const job = jobs.find(
      (candidate): candidate is { name: string; conclusion: string } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "name" in candidate &&
        candidate.name === requiredJob &&
        "conclusion" in candidate &&
        typeof candidate.conclusion === "string",
    );
    invariant(job?.conclusion === "success", `${requiredJob} did not succeed for ${tag}`);
  }

  const metadata: unknown = JSON.parse(
    output("npm", [
      "view",
      `${releasePolicy.packageName}@${version}`,
      "version",
      "dist-tags.latest",
      "dist.shasum",
      "dist.integrity",
      "dist.attestations",
      "--json",
      "--registry=https://registry.npmjs.org/",
    ]),
  );
  invariant(typeof metadata === "object" && metadata !== null, "Invalid npm metadata");
  invariant("version" in metadata && metadata.version === version, "Registry version mismatch");
  invariant(
    "dist-tags.latest" in metadata && metadata["dist-tags.latest"] === version,
    "npm latest does not point to the release",
  );
  invariant(
    "dist.attestations" in metadata && metadata["dist.attestations"] !== undefined,
    "npm provenance is missing",
  );
  invariant(
    "dist.shasum" in metadata && typeof metadata["dist.shasum"] === "string",
    "npm SHA-1 is missing",
  );
  invariant(
    "dist.integrity" in metadata && typeof metadata["dist.integrity"] === "string",
    "npm integrity is missing",
  );

  const temporaryRoot = path.join(repositoryRoot, ".agents/tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const temporary = mkdtempSync(path.join(temporaryRoot, `finish-${version}-`));
  try {
    await progress.run("gh", [
      "run",
      "download",
      String(workflow.databaseId),
      "--repo",
      releasePolicy.publicRepository,
      "--name",
      `release-${version}`,
      "--dir",
      path.join(temporary, "validated"),
    ]);
    await progress.run(
      "npm",
      [
        "pack",
        `${releasePolicy.packageName}@${version}`,
        "--silent",
        "--registry=https://registry.npmjs.org/",
      ],
      { cwd: temporary },
    );
    const registryTarball = path.join(temporary, `${releasePolicy.packageName}-${version}.tgz`);
    const validatedTarball = path.join(
      temporary,
      "validated",
      `${releasePolicy.packageName}-${version}.tgz`,
    );
    invariant(
      existsSync(registryTarball) && existsSync(validatedTarball),
      "Release tarball is missing",
    );
    invariant(
      hashFile(registryTarball) === hashFile(validatedTarball),
      "Published tarball differs from validated tarball",
    );
    invariant(
      output("sha1sum", [registryTarball]).split(" ")[0] === metadata["dist.shasum"],
      "Registry SHA-1 mismatch",
    );
    invariant(
      integrityFile(registryTarball) === metadata["dist.integrity"],
      "Registry integrity mismatch",
    );

    const smoke = path.join(temporary, "smoke");
    mkdirSync(smoke);
    await progress.run("npm", ["init", "--yes"], { cwd: smoke });
    await progress.run(
      "npm",
      [
        "install",
        `${releasePolicy.packageName}@${version}`,
        "--registry=https://registry.npmjs.org/",
      ],
      { cwd: smoke },
    );
    verifyInstalledPackage(smoke);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  const oldHead = output("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  const remoteHead = output(
    "git",
    ["rev-parse", `${releasePolicy.privateRemote}/${releasePolicy.privateBranch}`],
    { cwd: repositoryRoot },
  );
  invariant(oldHead === remoteHead, "Private develop must match its remote before finish");
  const backup = `backup/${releasePolicy.privateBranch}-before-${tag}`;
  invariant(
    !output("git", ["branch", "--list", backup], { cwd: repositoryRoot }),
    `Backup branch already exists: ${backup}`,
  );
  const files = output("git", ["ls-tree", "-r", "--name-only", oldHead], {
    cwd: repositoryRoot,
  }).split("\n");
  const restore = privateRestorePaths(files);
  const metadataFiles = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
  const releaseInfrastructureFiles = new Set([
    ".github/workflows/release.yml",
    "scripts/promote-release.ts",
    "scripts/publish-candidate.ts",
    "scripts/release/release-finish.ts",
  ]);
  const publicDrift = output("git", ["diff", "--name-only", tag, oldHead], { cwd: repositoryRoot })
    .split("\n")
    .filter(
      (file) =>
        file &&
        !restore.includes(file) &&
        !metadataFiles.has(file) &&
        !releaseInfrastructureFiles.has(file),
    );
  invariant(
    publicDrift.length === 0,
    `Unreleased public changes must be preserved before finish: ${publicDrift.join(", ")}`,
  );
  await progress.run("git", ["branch", backup, oldHead], { cwd: repositoryRoot });
  const worktree = path.join(repositoryRoot, ".agents/tmp", `finish-worktree-${version}`);
  await progress.run("git", ["worktree", "add", "--detach", worktree, tag], {
    cwd: repositoryRoot,
  });
  await progress.run(
    "git",
    [
      "restore",
      `--source=${backup}`,
      "--staged",
      "--worktree",
      "--",
      ...restore,
      "pnpm-workspace.yaml",
      ...releaseInfrastructureFiles,
    ],
    { cwd: worktree },
  );
  restorePrivateReleaseScripts(
    path.join(worktree, "package.json"),
    path.join(repositoryRoot, "package.json"),
  );
  await progress.run("pnpm", ["install", "--lockfile-only"], { cwd: worktree });
  await progress.run("pnpm", ["install", "--frozen-lockfile"], { cwd: worktree });
  await progress.run("pnpm", ["check"], { cwd: worktree });
  await progress.run("git", ["diff", "--exit-code", backup, "--", ...restore], { cwd: worktree });
  const changed = output("git", ["diff", "--name-only", tag], { cwd: worktree })
    .split("\n")
    .filter(Boolean);
  invariant(
    changed.every(
      (file) =>
        restore.includes(file) || metadataFiles.has(file) || releaseInfrastructureFiles.has(file),
    ),
    `Unexpected private-only paths: ${changed.join(", ")}`,
  );
  await progress.run("git", ["add", "--all"], { cwd: worktree });
  await progress.run(
    "git",
    ["commit", "--no-verify", "--message", `chore: rebuild private development onto ${tag}`],
    { cwd: worktree },
  );
  const rebuilt = output("git", ["rev-parse", "HEAD"], { cwd: worktree });
  invariant(
    output("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }) === oldHead,
    "Develop changed during finish",
  );
  invariant(
    output("git", ["status", "--porcelain"], { cwd: repositoryRoot }) === "",
    "Develop worktree changed during finish",
  );
  await progress.run("git", ["fetch", releasePolicy.privateRemote, releasePolicy.privateBranch], {
    cwd: repositoryRoot,
  });
  invariant(
    output("git", ["rev-parse", `${releasePolicy.privateRemote}/${releasePolicy.privateBranch}`], {
      cwd: repositoryRoot,
    }) === remoteHead,
    "Remote develop changed during finish",
  );
  await progress.run("git", ["reset", "--hard", rebuilt], { cwd: repositoryRoot });
  await progress.run("pnpm", ["install", "--frozen-lockfile"], { cwd: repositoryRoot });
  await progress.run("git", ["merge-base", "--is-ancestor", tag, "HEAD"], { cwd: repositoryRoot });
  await progress.run(
    "git",
    [
      "push",
      `--force-with-lease=refs/heads/${releasePolicy.privateBranch}:${remoteHead}`,
      releasePolicy.privateRemote,
      releasePolicy.privateBranch,
    ],
    { cwd: repositoryRoot },
  );
  console.log(
    JSON.stringify(
      {
        package: releasePolicy.packageName,
        version,
        tag,
        privateCommit: output("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

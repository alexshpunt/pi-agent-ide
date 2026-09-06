import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { verifyCandidateArchive, type CandidateEvidence } from "./release-candidate.ts";

const repository = "alexshpunt/pi-agent-ide";
const directory = ".agents/tmp/promoted-release";
const evidence = JSON.parse(
  readFileSync(`${directory}/candidate.json`, "utf8"),
) as CandidateEvidence;
const promotion = JSON.parse(readFileSync(`${directory}/promotion.json`, "utf8")) as {
  version: string;
  commit: string;
};
const version = process.env.RELEASE_VERSION;
const commit = process.env.RELEASE_COMMIT;
if (
  !version ||
  !commit ||
  version !== evidence.version ||
  version !== promotion.version ||
  commit !== promotion.commit ||
  evidence.repository !== repository
) {
  throw new Error("Promotion identity changed");
}
const archive = verifyCandidateArchive(directory, evidence);
type TagRequest =
  | { tag: string; message: string; object: string; type: "commit" }
  | { ref: string; sha: string };
async function github(route: string, body?: TagRequest, allowMissing = false) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${route}`, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${route}: ${response.status}`);
  return (await response.json()) as { object: { sha: string; type: string }; sha: string };
}
const main = await github("git/ref/heads/main");
if (main?.object.sha !== commit) throw new Error("Main changed while waiting for approval");
const tag = `v${version}`;
const existing = await github(`git/ref/tags/${tag}`, undefined, true);
if (existing) {
  if (existing.object.type !== "tag") throw new Error("Release tag must be annotated");
  const annotation = await github(`git/tags/${existing.object.sha}`);
  if (annotation?.object.type !== "commit" || annotation.object.sha !== commit)
    throw new Error("Existing tag points elsewhere");
}
const registry = await fetch(`https://registry.npmjs.org/pi-agent-ide/${version}`);
if (registry.ok) {
  const published = (await registry.json()) as { dist?: { integrity?: string } };
  const integrity = `sha512-${Buffer.from(evidence.sha512, "hex").toString("base64")}`;
  if (!existing || published.dist?.integrity !== integrity)
    throw new Error("Version already exists with different release evidence");
  console.log(`pi-agent-ide@${version} is already published with this exact archive`);
} else {
  if (registry.status !== 404) throw new Error(`Registry check failed: ${registry.status}`);
  if (!existing) {
    const annotation = await github("git/tags", {
      tag,
      message: `pi-agent-ide ${tag}`,
      object: commit,
      type: "commit",
    });
    if (!annotation) throw new Error("Tag creation returned no object");
    await github("git/refs", { ref: `refs/tags/${tag}`, sha: annotation.sha });
  }
  execFileSync("npm", ["publish", archive, "--access", "public", "--provenance"], {
    stdio: "inherit",
  });
}

import path from "node:path";

import { runContributedChecks } from "./core.js";
import { discoverRecipeCandidates, selectSuggestedRecipes } from "./discovery.js";
import { collectProjectFiles, detectProjectLanguages } from "./inventory.js";

import type { DoctorFinding } from "#src/api/doctor.js";
import type { DoctorSnapshot } from "./core.js";
import type { RecipeCandidate } from "./discovery.js";

export interface DoctorSection {
  readonly title: string;
  readonly pluginId: string;
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorRun {
  readonly cwd: string;
  readonly files: readonly string[];
  readonly detectedLanguages: ReadonlyMap<string, readonly string[]>;
  readonly candidates: readonly RecipeCandidate[];
  readonly suggestions: readonly RecipeCandidate[];
  readonly sections: readonly DoctorSection[];
}

/**
Runs one deterministic doctor inspection from the current contribution snapshot.
*/
export async function runDoctor(
  snapshot: DoctorSnapshot,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DoctorRun> {
  const files = await collectProjectFiles(cwd);
  const detectedLanguages = detectProjectLanguages(
    files,
    snapshot.languages.map((entry) => entry.value),
  );
  const languageIds = new Set(detectedLanguages.keys());
  const context = { cwd, files, detectedLanguageIds: languageIds, env: environment };
  const [candidates, checks] = await Promise.all([
    discoverRecipeCandidates(cwd, languageIds, snapshot.recipes, environment),
    runContributedChecks(snapshot, context),
  ]);
  const projectFindings: DoctorFinding[] = [
    { status: "pass", message: `Project: ${cwd}` },
    files.length > 0
      ? { status: "pass", message: `${files.length} project files inspected` }
      : { status: "warn", message: "No project files found" },
    languageIds.size > 0
      ? { status: "pass", message: `Detected: ${[...languageIds].join(", ")}` }
      : { status: "warn", message: "No registered project languages detected" },
  ];
  const toolFindings = toolCoverageFindings(detectedLanguages, candidates);
  return {
    cwd,
    files,
    detectedLanguages,
    candidates,
    suggestions: selectSuggestedRecipes(candidates, languageIds),
    sections: [
      { title: "Project", pluginId: "doctor", findings: projectFindings },
      { title: "Tool discovery", pluginId: "doctor", findings: toolFindings },
      ...checks,
    ],
  };
}

/**
Renders a redacted doctor report for the transcript and agent.
*/
export function formatDoctorReport(run: DoctorRun): string {
  const lines = ["Pi Agent IDE doctor", ""];

  for (const section of run.sections) {
    lines.push(`${section.title} (${section.pluginId})`);

    for (const finding of section.findings) {
      lines.push(`  ${finding.status.toUpperCase().padEnd(4)}  ${finding.message}`);

      if (finding.detail !== undefined) {
        lines.push(`        \`${finding.detail}\``);
      }
    }

    lines.push("");
  }

  if (run.suggestions.length > 0) {
    lines.push("Suggested configuration");

    for (const suggestion of run.suggestions) {
      const evidence = suggestion.evidence.length > 0 ? ` — ${suggestion.evidence.join(", ")}` : "";
      lines.push(
        `  ${suggestion.recipe.kind.padEnd(9)} ${suggestion.recipe.id} [${suggestion.pluginId}]${evidence}`,
      );
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

/**
Returns true when a report needs setup work.
*/
export function doctorNeedsWork(run: DoctorRun): boolean {
  return run.sections.some((section) =>
    section.findings.some((finding) => finding.status === "fail" || finding.status === "warn"),
  );
}

/**
Builds the redacted task delegated to the normal coding agent.
*/
export function buildDoctorAgentPrompt(run: DoctorRun): string {
  const relevantRecipes = run.candidates.map((candidate) => ({
    owner: candidate.pluginId,
    id: candidate.recipe.id,
    kind: candidate.recipe.kind,
    languages: candidate.recipe.languages,
    evidence: candidate.evidence,
    documentation: candidate.recipe.documentation,
  }));
  return [
    "Finish configuring Pi Agent IDE for this project.",
    "Preserve existing formatter, linter, compiler, and style rules. Do not invent or replace native project settings.",
    "Do not install packages, write credentials, or change source files without the user's normal confirmation.",
    "Pi Agent IDE project configs live in .pi/pi-agent-ide/.",
    "Use only the relevant plugin contributions listed below; each owner remains responsible for its own scope.",
    "",
    formatDoctorReport(run),
    "",
    "Relevant registered recipes:",
    JSON.stringify(relevantRecipes, null, 2),
    "",
    `Project root: ${path.resolve(run.cwd)}`,
  ].join("\n");
}

function toolCoverageFindings(
  detected: ReadonlyMap<string, readonly string[]>,
  candidates: readonly RecipeCandidate[],
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];

  for (const [language, files] of detected) {
    for (const kind of ["formatter", "linter", "lsp"] as const) {
      const matches = candidates.filter(
        (candidate) =>
          candidate.recipe.kind === kind && candidate.recipe.languages.includes(language),
      );
      const topScore = matches[0]?.score;
      const tied =
        topScore === undefined ? [] : matches.filter((candidate) => candidate.score === topScore);

      if (tied.length > 1 && tied.some((candidate) => candidate.evidence.length > 0)) {
        findings.push({
          status: "warn",
          message: `${language} ${kind}: choose between ${tied.map((item) => item.recipe.name).join(", ")}`,
        });
        continue;
      }

      const readyConfigured = matches.find(
        (candidate) =>
          candidate.evidence.includes("Pi Agent IDE config") ||
          (candidate.executable !== undefined &&
            candidate.evidence.some((item) => item.startsWith("project config:"))),
      );

      if (readyConfigured !== undefined) {
        findings.push({
          status: "pass",
          message: `${language} ${kind}: ${readyConfigured.recipe.name}`,
        });
      } else if (matches.length > 0) {
        findings.push({
          status: "warn",
          message: `${language} ${kind}: ${matches
            .map((item) => item.recipe.name)
            .join(", ")} available in catalog`,
          detail: `${files.length} matching files`,
        });
      } else {
        findings.push({
          status: "skip",
          message: `${language} ${kind}: no loaded plugin contribution`,
        });
      }
    }
  }

  return findings;
}

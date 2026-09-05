import path from "node:path";

import { runContributedChecks, runContributedSetupChecks } from "./core.js";
import { discoverRecipeCandidates, selectSuggestedRecipes } from "./discovery.js";
import { collectProjectFiles, detectProjectLanguages } from "./inventory.js";

import type { DoctorFinding, DoctorSetupAction, DoctorToolSelection } from "#src/api/doctor.js";
import type { DoctorSnapshot } from "./core.js";
import type { RecipeCandidate } from "./discovery.js";

export interface DoctorSection {
  readonly title: string;
  readonly pluginId: string;
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorSetupRun {
  readonly cwd: string;
  readonly files: readonly string[];
  readonly detectedLanguages: ReadonlyMap<string, readonly string[]>;
  readonly candidates: readonly RecipeCandidate[];
  readonly suggestions: readonly RecipeCandidate[];
  readonly selections: readonly (DoctorToolSelection & { readonly pluginId: string })[];
  readonly actions: readonly (DoctorSetupAction & { readonly pluginId: string })[];
}

export interface DoctorRun extends DoctorSetupRun {
  readonly sections: readonly DoctorSection[];
}

/** Runs the lightweight setup inspection used by startup guidance. */
export async function inspectDoctorSetup(
  snapshot: DoctorSnapshot,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<DoctorSetupRun> {
  signal?.throwIfAborted();
  const files = await collectProjectFiles(cwd, signal);
  signal?.throwIfAborted();
  const detectedLanguages = detectProjectLanguages(
    files,
    snapshot.languages.map((entry) => entry.value),
  );
  const detectedLanguageIds = new Set(detectedLanguages.keys());
  const context = { cwd, files, detectedLanguageIds, detectedLanguages, env: environment };
  const [candidates, setup] = await Promise.all([
    discoverRecipeCandidates(cwd, detectedLanguageIds, snapshot.recipes, environment),
    runContributedSetupChecks(snapshot, context),
  ]);

  return {
    cwd,
    files,
    detectedLanguages,
    candidates,
    selections: setup.selections,
    actions: setup.actions,
    suggestions: selectSuggestedRecipes(candidates, detectedLanguageIds, setup.selections),
  };
}

/** Runs one deterministic full doctor inspection from the current contribution snapshot. */
export async function runDoctor(
  snapshot: DoctorSnapshot,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DoctorRun> {
  const setup = await inspectDoctorSetup(snapshot, cwd, environment);
  const detectedLanguageIds = new Set(setup.detectedLanguages.keys());
  const context = {
    cwd,
    files: setup.files,
    detectedLanguageIds,
    detectedLanguages: setup.detectedLanguages,
    env: environment,
  };
  const checks = await runContributedChecks(snapshot, context);
  const projectFindings: DoctorFinding[] = [
    { status: "pass", message: `Project: ${cwd}` },
    setup.files.length > 0
      ? { status: "pass", message: `${setup.files.length} project files inspected` }
      : { status: "warn", message: "No project files found" },
    detectedLanguageIds.size > 0
      ? { status: "pass", message: `Detected: ${[...detectedLanguageIds].join(", ")}` }
      : { status: "warn", message: "No registered project languages detected" },
  ];
  return {
    ...setup,
    sections: [{ title: "Project", pluginId: "doctor", findings: projectFindings }, ...checks],
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

  if (run.actions.length > 0) {
    lines.push("Setup needs attention");

    for (const action of run.actions) {
      lines.push(`  ${action.message} [${action.pluginId}]`);
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
  return (
    run.actions.length > 0 ||
    run.suggestions.length > 0 ||
    run.sections.some((section) => section.findings.some((finding) => finding.status === "fail"))
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

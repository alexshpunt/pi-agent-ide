import type { Runtime } from "#axi/types.ts";
import { optionalText } from "./command-input.ts";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFlags, usage } from "#axi/args.ts";
import { collapseHome } from "#axi/config.ts";
import { renderToon } from "#axi/format.ts";
import { formatCommandArg } from "#axi/lib/cli-helpers.ts";
import {
  findGitRoot,
  projectFileValue,
  readProjectFile,
  validateRepoProject,
} from "#axi/lib/repo-project.ts";
import { initHelp } from "./help.ts";

export async function initCommand(args: string[], runtime: Runtime) {
  const parsed = parseFlags(args, {
    boolean: ["help", "force"],
    example: 'init --project "Roadmap"',
  });
  if (parsed.help) return initHelp();
  const project = (optionalText(parsed.project) ?? parsed.positionals.at(0) ?? "").trim();
  if (!project) {
    throw usage("--project is required", ['Run `linear-axi init --project "<project>"`']);
  }
  const repo = await findGitRoot(runtime.cwd);
  if (!repo) {
    throw usage("current directory is not inside a Git repository", [
      "Run `git init` first",
      'Run `linear-axi init --project "<project>"` from a Git repository',
    ]);
  }

  const path = join(repo, ".linear-project");
  let existing: Awaited<ReturnType<typeof readProjectFile>>;
  try {
    existing = await readProjectFile(path);
  } catch (error) {
    if (!parsed.force) throw error;
    existing = null;
  }
  if (existing?.project === project) {
    const validated = await validateRepoProject(parsed.force ? { project } : existing, runtime);
    if (validated.workspace && existing.workspace !== validated.workspace) {
      await writeProjectFile(path, validated);
      return renderToon({
        project: "initialized",
        file: collapseHome(path),
        value: projectFileValue(validated),
      });
    }
    return renderToon({
      project: "already initialized",
      file: collapseHome(path),
      value: projectFileValue(existing),
    });
  }
  if (existing && !parsed.force) {
    throw usage(".linear-project already exists with a different project", [
      `Run \`linear-axi init --project ${formatCommandArg(project)} --force\` to replace it`,
      "Run `linear-axi issues list --project <project>` to override the repo default once",
    ]);
  }

  const validated = await validateRepoProject({ project }, runtime);
  await writeProjectFile(path, validated);
  return renderToon({
    project: "initialized",
    file: collapseHome(path),
    value: projectFileValue(validated),
  });
}

async function writeProjectFile(path: string, repoProject: Parameters<typeof projectFileValue>[0]) {
  await writeFile(path, `${JSON.stringify(projectFileValue(repoProject), null, 2)}\n`, "utf8");
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  assistantMessage,
  getProviderSystemPrompt,
  PiIntegrationTest,
  text,
} from "pi-coding-agent-test/base";

export interface SystemPromptSnapshotOptions {
  readonly cwd: string;
  readonly extensions?: readonly string[];
  readonly skills?: readonly string[];
  readonly tools?: readonly string[];
  readonly systemPrompt?: string;
  readonly appendSystemPrompt?: readonly string[];
  readonly piCommand?: string;
  readonly artifactsDir?: string;
  readonly testName?: string;
}

/** Run real Pi with its deterministic scripted provider and return the first effective system prompt. */
export async function snapshotSystemPrompt(options: SystemPromptSnapshotOptions): Promise<string> {
  const cwd = path.resolve(options.cwd);
  const artifactsDir = path.resolve(cwd, options.artifactsDir ?? ".agents/tmp/system-prompt-runs");
  const relativeArtifacts = path.relative(cwd, artifactsDir);
  if (relativeArtifacts.startsWith(`..${path.sep}`) || path.isAbsolute(relativeArtifacts)) {
    throw new Error(
      "artifactsDir must be inside cwd so Pi runs against the requested working directory",
    );
  }

  const result = await new PiIntegrationTest({
    testName: options.testName ?? "system-prompt-snapshot",
    artifactsDir,
    cwd,
    isolateUserResources: true,
    extensions: options.extensions?.map((value) => path.resolve(value)),
    skills: options.skills?.map((value) => path.resolve(value)),
    tools: options.tools,
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt,
    piCommand: options.piCommand,
    conversation: [assistantMessage([text("System prompt captured.")])],
  }).run("Capture the effective system prompt");

  return getProviderSystemPrompt(result);
}

interface CliOptions extends SystemPromptSnapshotOptions {
  readonly output?: string;
}

function takeValue(arguments_: readonly string[], index: number, flag: string): string {
  const value = arguments_[index + 1];
  if (value === undefined) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseArguments(arguments_: readonly string[]): CliOptions {
  arguments_ = arguments_.filter((argument) => argument !== "--");
  let cwd = process.cwd();
  let output: string | undefined;
  let piCommand: string | undefined;
  let artifactsDir: string | undefined;
  let systemPrompt: string | undefined;
  const extensions: string[] = [];
  const skills: string[] = [];
  const tools: string[] = [];
  const appendSystemPrompt: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    const value = () => takeValue(arguments_, index++, flag ?? "argument");

    if (flag === "--cwd") cwd = value();
    else if (flag === "--extension") extensions.push(value());
    else if (flag === "--skill") skills.push(value());
    else if (flag === "--tool") tools.push(value());
    else if (flag === "--system-prompt") systemPrompt = value();
    else if (flag === "--append-system-prompt") appendSystemPrompt.push(value());
    else if (flag === "--pi-command") piCommand = value();
    else if (flag === "--artifacts-dir") artifactsDir = value();
    else if (flag === "--output") output = value();
    else throw new Error(`Unknown argument: ${flag}`);
  }

  return {
    cwd,
    ...(output === undefined ? {} : { output }),
    ...(piCommand === undefined ? {} : { piCommand }),
    ...(artifactsDir === undefined ? {} : { artifactsDir }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(extensions.length === 0 ? {} : { extensions }),
    ...(skills.length === 0 ? {} : { skills }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(appendSystemPrompt.length === 0 ? {} : { appendSystemPrompt }),
  };
}

function normalizeSnapshotPrompt(prompt: string): string {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const packageRoot = path.dirname(path.dirname(packageEntry));
  const repositoryRoot = process.cwd();

  return prompt
    .replaceAll(packageRoot, "<PI_CODING_AGENT_PACKAGE>")
    .replaceAll(repositoryRoot, "<PI_AGENT_IDE_REPOSITORY>");
}

async function main(): Promise<void> {
  const { output, ...options } = parseArguments(process.argv.slice(2));
  const prompt = await snapshotSystemPrompt(options);

  if (output === undefined) {
    process.stdout.write(prompt);
    return;
  }

  const outputPath = path.resolve(output);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, normalizeSnapshotPrompt(prompt), "utf8");
  process.stdout.write(`${outputPath}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}

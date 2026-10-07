import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { format } from "oxfmt";
import {
  assistantMessage,
  getProviderSystemPrompt,
  getToolResultMessage,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import {
  getCurrentTools,
  type ConstrainedSamplingConfig,
  type Message,
} from "@earendil-works/pi-ai";

interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly constrainedSampling?: false | ConstrainedSamplingConfig;
}

interface ModelRequestCapture {
  readonly systemPrompt: string;
  readonly tools: readonly ToolInfo[];
}

interface DiscoveryReply {
  readonly name: string;
  readonly description: string;
}

interface Options {
  readonly cwd: string;
  readonly extension: string;
  readonly output: string;
  readonly declarationsOutput?: string;
  readonly tools?: readonly string[];
  /** Select the runner transport. Omit for the existing TUI runner. */
  readonly transport?: "tui" | "rpc";
}

function outputPaths(options: Options): { initial: string; declarations: string } {
  const initial = path.resolve(options.cwd, options.output);
  const declarations =
    options.declarationsOutput === undefined
      ? path.join(
          path.dirname(initial),
          `${path.basename(initial, path.extname(initial))}-declarations.md`,
        )
      : path.resolve(options.cwd, options.declarationsOutput);
  if (initial === declarations)
    throw new Error("Initial and discovery exports need separate paths");
  return { initial, declarations };
}

/** Export the first model request and on-demand discovery replies into separate documents. */
export async function exportAgentInterface(options: Options): Promise<void> {
  const cwd = path.resolve(options.cwd);
  const outputs = outputPaths(options);
  const artifacts = path.join(cwd, ".agents", "tmp", "agent-interface-export");
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });

  const discovery = options.tools === undefined || options.tools.includes("codemode");
  const result = await new PiIntegrationTest({
    testName: "agent-interface-export",
    rawMode: false,
    artifactsDir: artifacts,
    cwd,
    isolateUserResources: true,
    extensions: [path.resolve(cwd, options.extension), "builtin:codemode", "builtin:tool-search"],
    ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    conversation: [
      ...(discovery
        ? [
            assistantMessage(
              [
                toolCall({
                  id: "interface-declarations",
                  name: "codemode",
                  arguments: {
                    code: '// @options: {"max_output_tokens": 100000}\nreturn await Promise.all(ALL_TOOLS.map(async ({name}) => ({name, description: await describeTool(name)})));',
                  },
                }),
              ],
              { stopReason: "toolUse" },
            ),
          ]
        : []),
      assistantMessage([text("Captured.")]),
    ],
  }).run("Capture the initial model request, then retrieve tool declarations separately");

  const messages = result.providerRequests[0]?.messages;
  if (!Array.isArray(messages)) throw new Error("The first model request was not recorded");
  const captured: ModelRequestCapture = {
    systemPrompt: getProviderSystemPrompt(result, 0),
    tools: getCurrentTools(messages as Message[]),
  };
  await writeFile(
    path.join(artifacts, "model-request.json"),
    JSON.stringify(captured, null, 2),
    "utf8",
  );

  let samples: DiscoveryReply[] = [];
  if (discovery) {
    const message = getToolResultMessage(result, "interface-declarations");
    if (message.isError) throw new Error("Codemode interface discovery failed");
    const block = message.content.at(-1);
    if (block?.type !== "text") throw new Error("Codemode did not return discovery replies");
    samples = JSON.parse(block.text) as DiscoveryReply[];
    if (
      !samples.every(
        (sample) => typeof sample.name === "string" && typeof sample.description === "string",
      )
    )
      throw new Error("Codemode returned an invalid discovery reply");
  }
  await writeFile(
    path.join(artifacts, "codemode-declarations.json"),
    JSON.stringify(samples, null, 2),
    "utf8",
  );

  await mkdir(path.dirname(outputs.initial), { recursive: true });
  await mkdir(path.dirname(outputs.declarations), { recursive: true });
  await writeFile(outputs.initial, renderMarkdown(captured, cwd), "utf8");
  await writeFile(outputs.declarations, await renderDeclarationsMarkdown(samples, cwd), "utf8");
}

/** Render only fields from the first model request, without adding discovery or registry metadata. */
export function renderMarkdown(capture: ModelRequestCapture, cwd: string): string {
  const lines = [
    "# Initial agent interface",
    "",
    `Captured from the first model request in a separate Pi runtime in \`${cwd}\`.`,
    "",
    "This file contains the request's system prompt and tool declarations. Text and schema values are unchanged. On-demand describeTool replies are not included.",
    "",
    "## Contents",
    "",
    "- [System prompt](#system-prompt)",
    ...capture.tools.map((tool) => `- [${tool.name}](#tool-${tool.name})`),
    "",
    "## System prompt",
    "",
    fence("text", capture.systemPrompt),
    "",
  ];
  for (const tool of capture.tools) {
    lines.push(
      `## Tool: ${tool.name}`,
      "",
      "### Description",
      "",
      fence("text", tool.description),
      "",
      "### Parameter schema",
      "",
      fence("json", JSON.stringify(tool.parameters, null, 2)),
      "",
    );
    if (tool.constrainedSampling !== undefined) {
      lines.push(
        "### Constrained sampling",
        "",
        fence("json", JSON.stringify({ constrainedSampling: tool.constrainedSampling }, null, 2)),
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Render the separately retrieved describeTool replies, with readable and exact forms. */
export async function renderDeclarationsMarkdown(
  samples: readonly DiscoveryReply[],
  cwd: string,
): Promise<string> {
  const lines = [
    "# Tool declarations — on demand",
    "",
    `Retrieved through describeTool in a separate Pi runtime in \`${cwd}\`.`,
    "",
    "These are discovery replies, not extra declarations added to the initial model request. Each reply contains the tool description and TypeScript input/return types. TypeScript does not express every JSON Schema constraint.",
    "",
    ...(samples.length === 0
      ? ["No replies were retrieved because Codemode was not selected.", ""]
      : []),
    "## Contents",
    "",
    ...samples.map((sample) => `- [${sample.name}](#tool-${sample.name})`),
    "",
  ];
  for (const sample of samples) {
    lines.push(
      `## Tool: ${sample.name}`,
      "",
      "### describeTool reply — formatted for reading",
      "",
      await formatTypeScriptBlocks(sample.description),
      "",
      "<details>",
      "<summary>Exact describeTool reply</summary>",
      "",
      fence("text", sample.description),
      "",
      "</details>",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

async function formatTypeScriptBlocks(source: string): Promise<string> {
  let formatted = source;
  for (const match of source.matchAll(/```ts\n([\s\S]*?)\n```/g)) {
    const result = await format("agent-interface.ts", match[1] ?? "", { printWidth: 90 });
    if (result.errors.length > 0)
      throw new Error(`Cannot format tool declaration: ${result.errors[0]?.message}`);
    formatted = formatted.replace(match[0], fence("ts", result.code.trimEnd()));
  }
  return formatted;
}

function fence(language: string, value: string): string {
  const runs = [...value.matchAll(/`{3,}/g)].map((match) => match[0].length);
  const delimiter = "`".repeat(Math.max(3, ...runs.map((length) => length + 1)));
  return `${delimiter}${language}\n${value}\n${delimiter}`;
}

function parseArguments(arguments_: readonly string[]): Options {
  let cwd = process.cwd();
  let extension = "src/pi-agent-ide.ts";
  let output = ".tmp/prompt-snapshots/pi-agent-ide.md";
  let declarationsOutput: string | undefined;
  let tools: readonly string[] | undefined;
  let transport: "tui" | "rpc" | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === "--cwd" && value !== undefined) cwd = value;
    else if (flag === "--extension" && value !== undefined) extension = value;
    else if (flag === "--output" && value !== undefined) output = value;
    else if (flag === "--declarations-output" && value !== undefined) declarationsOutput = value;
    else if (flag === "--transport" && (value === "tui" || value === "rpc")) transport = value;
    else if (flag === "--tools" && value !== undefined)
      tools = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
    index += 1;
  }
  return {
    cwd,
    extension,
    output,
    ...(declarationsOutput === undefined ? {} : { declarationsOutput }),
    ...(tools === undefined ? {} : { tools }),
    ...(transport === undefined ? {} : { transport }),
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2).filter((argument) => argument !== "--"));
  await exportAgentInterface(options);
  const outputs = outputPaths(options);
  process.stdout.write(`${outputs.initial}\n${outputs.declarations}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assistantMessage, PiIntegrationTest, text } from "pi-coding-agent-test/base";

interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly promptGuidelines?: readonly string[];
}

interface AgentInterfaceCapture {
  readonly systemPrompt: string;
  readonly activeTools: readonly string[];
  readonly tools: readonly ToolInfo[];
}

interface Options {
  readonly cwd: string;
  readonly extension: string;
  readonly output: string;
  readonly tools?: readonly string[];
}

/** Export the effective system prompt and active tool schemas from a real configured Pi runtime. */
export async function exportAgentInterface(options: Options): Promise<void> {
  const cwd = path.resolve(options.cwd);
  const output = path.resolve(cwd, options.output);
  const artifacts = path.join(cwd, ".agents", "tmp", "agent-interface-export");
  const capture = path.join(artifacts, "capture.json");
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });

  await new PiIntegrationTest({
    testName: "agent-interface-export",
    artifactsDir: artifacts,
    cwd,
    isolateUserResources: true,
    extensions: [
      path.resolve(cwd, options.extension),
      fileURLToPath(new URL("./capture-agent-interface-extension.ts", import.meta.url)),
    ],
    ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
    environment: { PI_AGENT_INTERFACE_CAPTURE: capture },
    conversation: [assistantMessage([text("Captured.")])],
  }).run("Capture the effective agent interface");

  const captured = JSON.parse(await readFile(capture, "utf8")) as AgentInterfaceCapture;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, renderMarkdown(captured, cwd), "utf8");
}

function renderMarkdown(capture: AgentInterfaceCapture, cwd: string): string {
  const active = new Set(capture.activeTools);
  const tools = capture.tools.filter((tool) => active.has(tool.name));
  const lines = [
    "# Effective Pi Agent IDE agent interface",
    "",
    `Captured from the real configured Pi runtime in \`${cwd}\`.`,
    "",
    "## Contents",
    "",
    "- [System prompt](#system-prompt)",
    "- [Active tools](#active-tools)",
    ...tools.map((tool) => `  - [${tool.name}](#tool-${tool.name})`),
    "",
    "## System prompt",
    "",
    fence("text", normalizePaths(capture.systemPrompt, cwd)),
    "",
    "## Active tools",
    "",
    tools.map((tool) => `\`${tool.name}\``).join(", "),
    "",
  ];
  for (const tool of tools) {
    lines.push(
      `## Tool: ${tool.name}`,
      "",
      "### Description",
      "",
      normalizePaths(tool.description, cwd),
      "",
    );
    if (tool.promptGuidelines !== undefined && tool.promptGuidelines.length > 0) {
      lines.push(
        "### Prompt guidelines",
        "",
        ...tool.promptGuidelines.map((item) => `- ${normalizePaths(item, cwd)}`),
        "",
      );
    }
    lines.push(
      "### Parameter schema",
      "",
      fence("json", JSON.stringify(tool.parameters, null, 2)),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function normalizePaths(value: string, cwd: string): string {
  const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const packageRoot = path.dirname(path.dirname(packageEntry));
  return value
    .replaceAll(packageRoot, "<PI_CODING_AGENT_PACKAGE>")
    .replaceAll(cwd, "<PI_AGENT_IDE_REPOSITORY>");
}

function fence(language: string, value: string): string {
  return `\`\`\`${language}\n${value}\n\`\`\``;
}

function parseArguments(arguments_: readonly string[]): Options {
  let cwd = process.cwd();
  let extension = "src/pi-agent-ide.ts";
  let output = ".agents/tmp/agent-interface.md";
  let tools: readonly string[] | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === "--cwd" && value !== undefined) cwd = value;
    else if (flag === "--extension" && value !== undefined) extension = value;
    else if (flag === "--output" && value !== undefined) output = value;
    else if (flag === "--tools" && value !== undefined)
      tools = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    else throw new Error(`Unknown or incomplete argument: ${flag}`);
    index += 1;
  }
  return { cwd, extension, output, ...(tools === undefined ? {} : { tools }) };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2).filter((argument) => argument !== "--"));
  await exportAgentInterface(options);
  process.stdout.write(`${path.resolve(options.cwd, options.output)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();

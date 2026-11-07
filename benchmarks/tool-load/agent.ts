import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assistantMessage, PiIntegrationTest, text, toolCall } from "pi-coding-agent-test/base";
import {
  DETACHED_COUNT,
  detachedName,
  languages,
  unitEnd,
  unitMarker,
  type LanguageId,
} from "./languages.ts";
import { PROBE_FILE_ENVIRONMENT } from "./probe-extension.ts";
import { buildSteps, type AgentFiles } from "./steps.ts";

/** Configuration the runner passes to one agent process. */
export interface AgentConfig extends AgentFiles {
  readonly language: LanguageId;
  readonly projectDir: string;
  readonly agentDir: string;
  readonly repositoryRoot: string;
  readonly cycles: number;
  readonly piCommand: string;
  readonly timeoutMs: number;
  readonly pauseMs: number;
  /** Write V8 CPU profiles of Pi (and Node processes it starts) to `<agentDir>/profile`. */
  readonly profile: boolean;
}

export interface StepOutcome {
  readonly id: string;
  readonly tool: string;
  readonly isError: boolean;
  readonly problem?: string;
  /** Start of the result text, kept for failed steps. */
  readonly excerpt?: string;
}

export interface AgentResult {
  readonly agent: string;
  readonly language: LanguageId;
  readonly status: "passed" | "failed" | "crashed";
  readonly error?: string;
  readonly steps: readonly StepOutcome[];
  readonly fileProblems: readonly string[];
  readonly frameIntervalsMs: readonly number[];
  readonly exitCode: number | null;
  readonly wallMs: number;
  /** CPU of this harness process (terminal emulation, trace parsing), excluding Pi. */
  readonly harnessCpuMs: number;
}

const TOOLS = [
  "read",
  "search",
  "replace",
  "insert",
  "delete",
  "copy",
  "move",
  "write",
  "ast_search",
  "lsp_search",
  "codemode",
];

async function main(): Promise<void> {
  const configPath = process.argv[2];
  if (configPath === undefined) throw new Error("usage: agent.ts <config.json>");
  const config = JSON.parse(await readFile(configPath, "utf8")) as AgentConfig;
  const result = await runAgent(config);
  await writeFile(path.join(config.agentDir, "result.json"), `${JSON.stringify(result)}\n`);
}

async function runAgent(config: AgentConfig): Promise<AgentResult> {
  const spec = languages[config.language];
  const steps = buildSteps(spec, config, config.cycles);
  const started = performance.now();
  const base = {
    agent: config.agent,
    language: config.language,
  };
  try {
    const run = await new PiIntegrationTest({
      testName: "pi",
      artifactsDir: config.agentDir,
      transport: "tui",
      cwd: config.projectDir,
      rawMode: false,
      timeoutMs: config.timeoutMs,
      isolateUserResources: true,
      piCommand: config.piCommand,
      extensions: [
        path.join(config.repositoryRoot, "src/pi-agent-ide.ts"),
        "builtin:codemode",
        fileURLToPath(new URL("./probe-extension.ts", import.meta.url)),
      ],
      tools: TOOLS,
      environment: {
        PI_SKIP_VERSION_CHECK: "1",
        PI_AGENT_IDE_TEST_SKIP_GUIDE_GATE: "1",
        [PROBE_FILE_ENVIRONMENT]: path.join(config.agentDir, "probe.jsonl"),
        ...(config.profile && {
          NODE_OPTIONS: `--cpu-prof --cpu-prof-dir=${path.join(config.agentDir, "profile")}`,
        }),
      },
      conversation: [
        ...steps.map((step) =>
          assistantMessage(
            [
              text(`Cycle ${step.cycle}: ${step.id}`, {
                chunks: { kind: "fixed", size: 6 },
                delayMs: 1,
              }),
              toolCall({
                id: step.id,
                name: step.tool,
                arguments: step.arguments,
                chunks: { kind: "fixed", size: 256 },
                delayMs: 1,
              }),
            ],
            { stopReason: "toolUse", delayMs: config.pauseMs },
          ),
        ),
        assistantMessage([text("All load steps finished.")]),
      ],
    }).run(`Run ${steps.length} scripted load steps on ${config.file}.`);

    const results = new Map<string, { text: string; isError: boolean }>();
    for (const message of run.messages as readonly ToolResultLike[]) {
      if (message.role !== "toolResult") continue;
      results.set(message.toolCallId, {
        isError: message.isError === true,
        text: (message.content ?? []).map((part) => part.text ?? "").join("\n"),
      });
    }
    const outcomes = steps.map((step): StepOutcome => {
      const found = results.get(step.id);
      if (found === undefined)
        return { id: step.id, tool: step.tool, isError: true, problem: "no tool result" };
      const expectsError = step.expectsError === true;
      const problem =
        found.isError === expectsError
          ? step.check(found.text)
          : found.isError
            ? "tool error"
            : "the tool accepted a call it should refuse";
      return {
        id: step.id,
        tool: step.tool,
        isError: found.isError,
        ...(problem !== undefined && { problem, excerpt: found.text.slice(0, 1200) }),
      };
    });
    const fileProblems = await checkFiles(config);
    const failed =
      outcomes.some((outcome) => outcome.problem !== undefined) || fileProblems.length > 0;
    return {
      ...base,
      status: failed ? "failed" : "passed",
      steps: outcomes,
      fileProblems,
      frameIntervalsMs: run.frameDelaysMs,
      exitCode: run.exitCode,
      wallMs: performance.now() - started,
      harnessCpuMs: cpuMs(),
    };
  } catch (error) {
    return {
      ...base,
      status: "crashed",
      error: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
      steps: [],
      fileProblems: [],
      frameIntervalsMs: [],
      exitCode: null,
      wallMs: performance.now() - started,
      harnessCpuMs: cpuMs(),
    };
  }
}

interface ToolResultLike {
  readonly role?: string;
  readonly toolCallId: string;
  readonly isError?: boolean;
  readonly content?: readonly { readonly text?: string }[];
}

/** Checks invariants of the final file: every unit once, detached functions back, no temporary code. */
async function checkFiles(config: AgentConfig): Promise<string[]> {
  const spec = languages[config.language];
  const content = await readFile(path.join(config.projectDir, config.file), "utf8");
  const problems: string[] = [];
  const count = (needle: string): number => content.split(needle).length - 1;
  for (let index = 0; index < config.unitCount; index += 1) {
    for (const marker of [
      unitMarker(spec, config.agent, index),
      unitEnd(spec, config.agent, index),
    ]) {
      if (count(`${marker}\n`) !== 1)
        problems.push(`${marker} occurs ${count(`${marker}\n`)} times`);
    }
  }
  for (let index = 0; index < DETACHED_COUNT; index += 1) {
    const name = `${detachedName(config.agent, index)}(`;
    if (count(name) !== 1) problems.push(`${name} occurs ${count(name)} times`);
  }
  for (const temporary of [
    `extra_${config.agent}_`,
    `broken_${config.agent}_`,
    `BROKEN_${config.agent.toUpperCase()}_`,
  ]) {
    if (content.includes(temporary)) problems.push(`${temporary} is still in the file`);
  }
  for (let cycle = 1; cycle <= config.cycles; cycle += 1) {
    if (!content.includes(`total + ${cycle} + `))
      problems.push(`symbol replacement of cycle ${cycle} is missing`);
  }
  return problems.slice(0, 20);
}

function cpuMs(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

await main();

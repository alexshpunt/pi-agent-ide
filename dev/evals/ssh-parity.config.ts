import { mkdir, readFile, rm, stat, chown, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  text,
  toolCall,
  type PiIntegrationTestResult,
} from "pi-coding-agent-test";
import { startSshFixture, type SshFixture } from "#integration/support/ssh-fixture.js";

interface Task {
  id: string;
}
interface Trial {
  task: Task;
  agentProfile: string;
}
interface State {
  resourceRoot: string;
  physicalRoot: string;
  parcel: string;
  returned: string;
  task: string;
  fixture?: SshFixture;
}
interface Prepared {
  cwd: string;
  state: State;
}
interface ToolEvent {
  toolName: string;
  toolCallId: string;
  isError: boolean;
  args?: Record<string, unknown>;
  result: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function events(run: Pick<PiIntegrationTestResult, "traceEvents">, type: string): ToolEvent[] {
  return run.traceEvents
    .filter((entry) => entry.type === type)
    .map((entry) => {
      const event = isRecord(entry.event) ? entry.event : entry;
      return {
        toolName: typeof event.toolName === "string" ? event.toolName : "",
        toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "",
        isError: event.isError === true,
        args: isRecord(event.args) ? event.args : undefined,
        result: event.result,
      };
    });
}
function rendered(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value);
}

async function matchesBytes(file: string, expected: Buffer): Promise<boolean> {
  try {
    return (await readFile(file)).equals(expected);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function completedService(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const source = typeof value.source === "string" ? value.source : undefined;
  if (
    source?.startsWith("shell:") &&
    value.status === "completed" &&
    (value.exitCode === 0 || value.exit_code === 0) &&
    typeof value.output === "string" &&
    value.output.includes("café RESULT 43")
  )
    return source;
  // Shell Read is an ordinary structured text resource, not a Bash result.
  // Inspect its header before output so program text cannot invent an exit status.
  if (source?.startsWith("shell:") && value.kind === "text" && Array.isArray(value.lines)) {
    const lines = value.lines.filter(isRecord).map((line) => line.content);
    const outputAt = lines.indexOf("output:");
    if (
      outputAt >= 0 &&
      lines.slice(0, outputAt).includes("status: completed") &&
      lines.slice(0, outputAt).includes("exitCode: 0") &&
      lines
        .slice(outputAt + 1)
        .some((line) => typeof line === "string" && line.includes("café RESULT 43"))
    )
      return source;
  }
  for (const child of Object.values(value)) {
    const found = completedService(child);
    if (found !== undefined) return found;
  }
  return undefined;
}
/** Count actual assistant turns for both real providers and the scripted provider. */
export function agentRounds(run: Pick<PiIntegrationTestResult, "traceEvents">): number {
  return run.traceEvents.filter((entry) => {
    if (entry.type !== "message_start" || !isRecord(entry.event)) return false;
    const message = entry.event.message;
    return isRecord(message) && message.role === "assistant";
  }).length;
}
/** Verify service completion and exact shell deletion from live or recorded Pi trace events. */
export function serviceOutcome(run: Pick<PiIntegrationTestResult, "traceEvents">): boolean {
  const calls = events(run, "tool_execution_start");
  const results = events(run, "tool_execution_end");
  const completed = results
    .filter((result) => !result.isError && ["bash", "read"].includes(result.toolName))
    .map((result) => completedService(result.result))
    .filter((source) => source !== undefined);
  return completed.some((source) =>
    calls.some(
      (call) =>
        call.toolName === "delete" &&
        call.args?.path === source &&
        results.some((result) => result.toolCallId === call.toolCallId && !result.isError),
    ),
  );
}
const repo = path.resolve();
const root = path.resolve(".tmp/ssh-parity-eval");
const initial = 'export const status = "TODO";\nexport const retries = 1;\n';
const binary = Buffer.from([0, 255, 128, 13, 10, 65]);
const service =
  'print("café READY", flush=True)\ncommand = input()\nprint("café RESULT 43" if command == "go" else "BAD INPUT", flush=True)\n';
const tasks = ["files-recovery", "mixed-transfer", "service"].map((id) => ({ id }));

/** Same task instructions and tools; only the prepared resource location differs. */
export const suite = {
  id: "ssh-parity",
  async loadBenchmarkPreset(name: string) {
    if (name !== "contracts") throw new Error(`Unknown preset: ${name}`);
    return { tasks, seed: 149, attempts: 1 };
  },
  async prepareTrial({
    trial,
    workspaceDirectory,
  }: {
    trial: Trial;
    workspaceDirectory: string;
  }): Promise<Prepared & { environment: Record<string, string> }> {
    let fixture: SshFixture | undefined;
    try {
      await mkdir(path.join(workspaceDirectory, ".pi/pi-agent-ide"), { recursive: true });
      if (trial.agentProfile === "ssh") fixture = await startSshFixture();
      const physicalRoot = fixture?.workspace ?? path.join(workspaceDirectory, "application");
      await mkdir(physicalRoot, { recursive: true });
      const resourceRoot = fixture ? `ssh://fixture${physicalRoot}` : physicalRoot;
      for (const [name, bytes] of [
        ["note.ts", initial],
        ["service.py", service],
      ] as const) {
        const file = path.join(physicalRoot, name);
        await writeFile(file, bytes);
        if (fixture) {
          const owner = await stat(physicalRoot);
          await chown(file, owner.uid, owner.gid);
        }
      }
      const parcel = path.join(workspaceDirectory, "parcel.bin");
      const returned = path.join(workspaceDirectory, "returned.bin");
      await writeFile(parcel, binary);
      const state = { resourceRoot, physicalRoot, parcel, returned, task: trial.task.id };
      await writeFile(
        path.join(workspaceDirectory, ".pi/ssh-eval-state.json"),
        JSON.stringify(state),
      );
      await writeFile(
        path.join(workspaceDirectory, ".pi/settings.json"),
        JSON.stringify({ packages: [] }),
      );
      await writeFile(
        path.join(workspaceDirectory, ".pi/pi-agent-ide/extensions.json"),
        JSON.stringify({
          noAnimations: true,
          noPostProcessing: true,
          modules: {
            "ide.lsp": false,
            "ide.lint": false,
            "ide.formatter": false,
            "ide.diagnostics": false,
            "ide.debugger": false,
          },
        }),
      );
      if (fixture)
        await writeFile(
          path.join(workspaceDirectory, ".pi/pi-agent-ide/ssh.json"),
          JSON.stringify({
            targets: [
              {
                id: "fixture",
                host: "fixture",
                workspace: physicalRoot,
                configFile: fixture.config,
              },
            ],
          }),
        );
      return {
        cwd: workspaceDirectory,
        state: { ...state, fixture },
        environment: { resourceRoot, backend: trial.agentProfile },
      };
    } catch (error) {
      if (fixture) await fixture.stop();
      throw error;
    }
  },
  prompt({ trial, prepared }: { trial: Trial; prepared: Prepared }) {
    const { resourceRoot, parcel, returned } = prepared.state;
    const common =
      "Use the existing IDE tools, not SSH commands, manual mirrors or shell file editing. Read current content before changes. If a guarded edit conflicts, reread and preserve the external writer's comment before retrying. Finish only after verifying the actual outcome.\n";
    if (trial.task.id === "files-recovery")
      return (
        common +
        `In ${resourceRoot}/note.ts, change status from TODO to ready and retries from 1 to 3. Preserve every comment. A test-owned external writer may change this file once during your first edit. Verify the saved file.`
      );
    if (trial.task.id === "mixed-transfer")
      return (
        common +
        `Copy the original bytes from ${parcel} to ${resourceRoot}/uploaded.bin, then copy that resource back to ${returned}. Preserve the original parcel. Verify the returned bytes using raw Read.`
      );
    return (
      common +
      `Run python3 service.py in ${resourceRoot} with stdin go followed by newline. Verify café RESULT 43 in its output and exit status. Remove any terminal sessions you create when done.`
    );
  },
  async validate({
    trial,
    prepared,
    piResult,
  }: {
    trial: Trial;
    prepared: Prepared;
    piResult: PiIntegrationTestResult;
  }) {
    const calls = events(piResult, "tool_execution_start");
    const results = events(piResult, "tool_execution_end");
    const manualTransport = calls.some(
      (call) =>
        call.toolName === "bash" &&
        /\b(?:ssh|scp|sftp|rsync)\b/u.test(
          typeof call.args?.command === "string" ? call.args.command : "",
        ),
    );
    let outcome: boolean;
    if (trial.task.id === "files-recovery") {
      outcome =
        (await readFile(path.join(prepared.state.physicalRoot, "note.ts"), "utf8")) ===
        `// external café preserved\n${initial.replace("TODO", "ready").replace("retries = 1", "retries = 3")}`;
    } else if (trial.task.id === "mixed-transfer") {
      outcome =
        (await matchesBytes(prepared.state.parcel, binary)) &&
        (await matchesBytes(prepared.state.returned, binary)) &&
        (await matchesBytes(path.join(prepared.state.physicalRoot, "uploaded.bin"), binary));
    } else {
      outcome = serviceOutcome(piResult);
    }
    const passed = outcome && !manualTransport;
    return {
      reward: Number(passed),
      passed,
      dimensions: { outcome, manualTransport },
      details: {
        trajectory: results.map((result) => ({
          tool: result.toolName,
          id: result.toolCallId,
          error: result.isError,
          conflict: rendered(result.result).includes("CONFLICT"),
        })),
      },
    };
  },
  async cleanupTrial({ prepared, keepWorkspace }: { prepared: Prepared; keepWorkspace: boolean }) {
    const fixture = prepared.state.fixture;
    if (fixture) {
      await fixture.stop();
      try {
        await stat(fixture.root);
        throw new Error("Owned SSH root survived cleanup");
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
    }
    if (!keepWorkspace) await rm(prepared.cwd, { recursive: true, force: true });
  },
};

function conversation(task: Task) {
  const setup =
    'for(const guide of ["docs:editing","docs:terminal","docs:read-resources"]) text(await tools.read({path:guide})); const stateRead = await tools.read({path: ".pi/ssh-eval-state.json"}); if(stateRead.status!=="success" || stateRead.data.kind!=="text") throw new Error("Missing state"); const state=JSON.parse(stateRead.data.lines.map(line=>line.content).join("\\n")); if(state.resourceRoot.startsWith("ssh://")) text(await tools.read({path:"docs:ssh"})); ';
  let code;
  if (task.id === "files-recovery") {
    return [
      assistantMessage([
        toolCall({
          id: "attempt",
          name: "codemode",
          arguments: {
            code:
              setup +
              'const source=state.resourceRoot+"/note.ts"; text(await tools.read({path:source})); text(await tools.replace({path:source,start:"TODO",text:"ready"}));',
          },
        }),
      ]),
      assistantMessage([
        toolCall({
          id: "recover",
          name: "codemode",
          arguments: {
            code:
              setup +
              'const source=state.resourceRoot+"/note.ts"; text(await tools.read({path:source})); text(await tools.replace({path:source,start:"TODO",text:"ready"})); text(await tools.replace({path:source,start:"retries = 1",text:"retries = 3"})); text(await tools.read({path:source}));',
          },
        }),
      ]),
      assistantMessage([text("Verified the saved file after the real external write.")]),
    ];
  } else if (task.id === "mixed-transfer")
    code =
      setup +
      'text(await tools.copy({path:state.parcel,target:state.resourceRoot+"/uploaded.bin"})); text(await tools.copy({path:state.resourceRoot+"/uploaded.bin",target:state.returned})); text(await tools.read({path:"raw:"+state.returned}));';
  else
    code =
      setup +
      'const session=await tools.bash({command:"python3 service.py",cwd:state.resourceRoot,timeoutSeconds:.1}); text(session); text(await tools.write({path:session.source,content:"go\\n"})); let finished=false; for(let attempt=0;attempt<20;attempt++){const snapshot=await tools.read({path:session.source}); text(snapshot); if(snapshot.status==="success" && snapshot.data.kind==="text" && snapshot.data.lines.some(line=>line.content==="status: completed")){finished=true;break;}} if(!finished) throw new Error("Service did not finish within the bounded Read checks"); text(await tools.delete({path:session.source}));';
  return [
    assistantMessage([toolCall({ id: task.id, name: "codemode", arguments: { code } })]),
    assistantMessage([text("Verified the actual task outcome.")]),
  ];
}

const scripted = process.env.PI_SSH_EVAL_SCRIPTED === "1";
const profile = (id: string) => ({
  id,
  tools: ["read", "search", "write", "replace", "copy", "move", "delete", "bash", "codemode"],
  extensions: [
    "builtin:codemode",
    "builtin:tool-search",
    path.join(repo, "src/pi-agent-ide.ts"),
    path.join(repo, "tests/integration/support/ssh-eval-recovery-extension.ts"),
  ],
  ...(scripted ? { conversation } : {}),
});
export default {
  resultsDirectory: path.join(root, "results"),
  workspacesDirectory: path.join(root, "workspaces"),
  suites: { "ssh-parity": suite },
  agentProfiles: { local: profile("local"), ssh: profile("ssh") },
  metricCalculators: [
    {
      id: "rounds",
      calculate: ({ piResult }: { piResult: PiIntegrationTestResult }) => agentRounds(piResult),
    },
    {
      id: "tool-context-bytes",
      calculate: ({ piResult }: { piResult: PiIntegrationTestResult }) =>
        piResult.messages
          .filter(isRecord)
          .filter((message) => message.role === "toolResult")
          .reduce((bytes, message) => bytes + Buffer.byteLength(rendered(message.content)), 0),
    },
    {
      id: "conflicts",
      calculate: ({ piResult }: { piResult: PiIntegrationTestResult }) =>
        events(piResult, "tool_execution_end").filter((event) =>
          rendered(event.result).includes("CONFLICT"),
        ).length,
    },
  ],
};

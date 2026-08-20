export interface AgentTask {
  readonly id: string;
  readonly title: string;
  readonly files: readonly string[];
  readonly priority: "low" | "normal" | "high";
}

export interface AgentRun {
  readonly task: AgentTask;
  readonly startedAt: number;
  readonly attempts: number;
  readonly messages: readonly string[];
}

export interface WorkspaceState {
  readonly root: string;
  readonly activeFile?: string;
  readonly tasks: readonly AgentTask[];
}

const DEFAULT_ATTEMPTS = 2;
const MAX_FILES_PER_TASK = 12;

export function createTask(id: string, title: string, files: readonly string[]): AgentTask {
  if (files.length > MAX_FILES_PER_TASK) {
    throw new Error(`Task ${id} contains too many files`);
  }

  return {
    id,
    title: title.trim(),
    files: [...files],
    priority: "normal",
  };
}

export function normalizeWorkspace(root: string, tasks: readonly AgentTask[]): WorkspaceState {
  const normalizedRoot = root.replaceAll("\\", "/");

  return {
    root: normalizedRoot,
    tasks,
  };
}

export function describeLegacyTask(task: AgentTask): string {
  const fileList = task.files.length === 0 ? "no files" : task.files.join(", ");
  const priority = task.priority.toUpperCase();
  const heading = `[legacy:${task.id}] ${task.title}`;

  return [heading, `priority=${priority}`, `files=${fileList}`].join(" | ");
}

export function selectNextTask(tasks: readonly AgentTask[]): AgentTask | undefined {
  return tasks.find((task) => task.priority === "high") ?? tasks[0];
}

export function createRun(task: AgentTask, now = Date.now()): AgentRun {
  return {
    task,
    startedAt: now,
    attempts: DEFAULT_ATTEMPTS,
    messages: [],
  };
}

export function appendRunMessage(run: AgentRun, message: string): AgentRun {
  return {
    ...run,
    messages: [...run.messages, message],
  };
}

export function canRetry(run: AgentRun): boolean {
  return run.attempts > 0;
}

export function consumeAttempt(run: AgentRun): AgentRun {
  if (!canRetry(run)) {
    return run;
  }

  return {
    ...run,
    attempts: run.attempts - 1,
  };
}

export function summarizeRun(run: AgentRun): string {
  const duration = Date.now() - run.startedAt;
  const fileCount = run.task.files.length;

  return [
    `task=${run.task.id}`,
    `files=${fileCount}`,
    `messages=${run.messages.length}`,
    `duration=${duration}`,
  ].join(" ");
}

export function groupTasksByPriority(
  tasks: readonly AgentTask[],
): Map<AgentTask["priority"], AgentTask[]> {
  const groups = new Map<AgentTask["priority"], AgentTask[]>([
    ["low", []],
    ["normal", []],
    ["high", []],
  ]);

  for (const task of tasks) {
    groups.get(task.priority)?.push(task);
  }

  return groups;
}

export function closeRun(run: AgentRun): AgentRun {
  return appendRunMessage(run, "run closed");
}

export function formatDebugRun(run: AgentRun): string {
  return JSON.stringify(run, undefined, 2);
}

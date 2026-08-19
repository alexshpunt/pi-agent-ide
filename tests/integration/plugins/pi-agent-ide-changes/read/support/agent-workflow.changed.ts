export interface AgentTask
{
    readonly id: string;
    readonly title: string;
    readonly files: readonly string[];
    readonly priority: "low" | "normal" | "high" | "urgent";
    readonly tags: readonly string[];
}

export interface AgentRun
{
    readonly task: AgentTask;
    readonly startedAt: number;
    readonly attempts: number;
    readonly messages: readonly string[];
}

export interface WorkspaceState
{
    readonly root: string;
    readonly activeFile?: string;
    readonly tasks: readonly AgentTask[];
}

const DEFAULT_ATTEMPTS = 3;
const MAX_FILES_PER_TASK = 12;

export function createTask(id: string, title: string, files: readonly string[]): AgentTask
{
    if (files.length > MAX_FILES_PER_TASK)
    {
        throw new Error(`Task ${id} contains too many files`);
    }

    const normalizedFiles = [...new Set(files)].sort();

    return {
        id,
        title: title.trim(),
        files: normalizedFiles,
        priority: normalizedFiles.length > 8 ? "high" : "normal",
        tags: [],
    };
}

export function normalizeWorkspace(root: string, tasks: readonly AgentTask[]): WorkspaceState
{
    const normalizedRoot = root.replaceAll("\\", "/");

    return {
        root: normalizedRoot,
        tasks,
    };
}

export function selectNextTask(tasks: readonly AgentTask[]): AgentTask | undefined
{
    return tasks.find((task) => task.priority === "high") ?? tasks[0];
}

export function createRun(task: AgentTask, now = Date.now()): AgentRun
{
    return {
        task,
        startedAt: now,
        attempts: DEFAULT_ATTEMPTS,
        messages: [],
    };
}

export function appendRunMessage(run: AgentRun, message: string): AgentRun
{
    return {
        ...run,
        messages: [...run.messages, message],
    };
}

export function appendRunMessages(run: AgentRun, messages: readonly string[]): AgentRun
{
    return {
        ...run,
        messages: [...run.messages, ...messages],
    };
}

export function canRetry(run: AgentRun): boolean
{
    return run.attempts > 0;
}

export function consumeAttempt(run: AgentRun): AgentRun
{
    if (!canRetry(run))
    {
        return appendRunMessage(run, "retry budget exhausted");
    }

    return {
        ...run,
        attempts: run.attempts - 1,
        messages: [...run.messages, `retry ${run.attempts}`],
    };
}

export function summarizeRun(run: AgentRun): string
{
    const duration = Date.now() - run.startedAt;
    const fileCount = run.task.files.length;

    return [
        `task=${run.task.id}`,
        `files=${fileCount}`,
        `messages=${run.messages.length}`,
        `durationMs=${duration}`,
        `priority=${run.task.priority}`,
    ].join(" ");
}

export function groupTasksByPriority(tasks: readonly AgentTask[]): Map<AgentTask["priority"], AgentTask[]>
{
    const groups = new Map<AgentTask["priority"], AgentTask[]>([
        ["low", []],
        ["normal", []],
        ["high", []],
        ["urgent", []],
    ]);

    for (const task of tasks)
    {
        groups.get(task.priority)?.push(task);
    }

    return groups;
}

export function closeRun(run: AgentRun): AgentRun
{
    return appendRunMessages(run, ["run completed", `task ${run.task.id} closed`]);
}

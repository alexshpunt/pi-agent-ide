import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface ExecOptions
{
    cwd: string;
    /** Timeout in ms. On timeout the child is killed and { timedOut: true } returned. */
    timeoutMs: number;
}

export interface ExecResult
{
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

interface ExecFileError extends Error
{
    code?: string;
    err?: unknown;
}

/**
 * Run a command, capture stdout/stderr, and never throw.
 * Non-zero exit returns { code } with captured output; timeout is reported.
 */
export async function runCommand(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult>
{
    try
    {
        const result = await execFile(cmd, args, {
            cwd: opts.cwd,
            maxBuffer: 10 * 1024 * 1024,
            timeout: opts.timeoutMs,
        });
        return { code: 0, stdout: result.stdout, stderr: result.stderr, timedOut: false };
    }
    catch (error)
    {
        const err = error as ExecFileError;
        const timedOut = err.code === "ETIMEDOUT";
        const code = typeof err.err === "number" ? err.err : 1;
        const stdout = (err as unknown as { stdout?: string; }).stdout ?? "";
        const stderr = (err as unknown as { stderr?: string; }).stderr ?? err.message;
        return { code, stdout, stderr, timedOut };
    }
}

import { createHash } from "node:crypto";

import { deleteFile, restoreSnapshot } from "./snapshot.js";
import { loadStack, saveStack } from "./stack-store-persist.js";
import { MAX_STACK_SIZE } from "./types.js";

import type { StackDisplayEntry, StackEntry, UndoResult } from "./types.js";

class StackStore
{
    #cwd: string | null = null;
    #sessionId: string | null = null;
    private entries: StackEntry[] = [];
    #acknowledgedSequences = new Set<number>();
    #pendingPreview: { filepath: string | undefined; steps: number; sequences: number[]; } | null = null;
    #nextSequence = 1;

    /** Push a per-file entry onto the history. */
    push(entry: StackEntry): void
    {
        const stored: StackEntry = { ...entry, sequence: this.#nextSequence++ };
        this.entries.push(stored);

        if (this.entries.length > MAX_STACK_SIZE)
        {
            const removed = this.entries.splice(0, this.entries.length - MAX_STACK_SIZE);

            for (const oldEntry of removed)
            {
                this.#acknowledgedSequences.delete(oldEntry.sequence);
            }
        }

        this.#save();
    }

    /**
     * Initialize with workspace context.
     * Loads persisted entries for this session if not already initialized.
     * Idempotent — safe to call multiple times with same parameters.
     */
    init(cwd: string, sessionId: string): void
    {
        if (this.#cwd === cwd && this.#sessionId === sessionId)
        {
            return;
        }

        this.#cwd = cwd;
        this.#sessionId = sessionId;
        this.entries = [];
        this.#acknowledgedSequences = new Set<number>();
        this.#pendingPreview = null;
        this.#nextSequence = 1;

        const loaded = loadStack(cwd, sessionId);

        if (loaded)
        {
            this.entries = [...loaded.entries].sort((a, b) => a.sequence - b.sequence);
            this.#acknowledgedSequences = loaded.acknowledgedSequences;
            let maxSequence = 0;

            for (const entry of this.entries)
            {
                maxSequence = Math.max(maxSequence, entry.sequence);
            }

            this.#nextSequence = maxSequence + 1;
        }
    }

    /** Persist current entries + acknowledgements (no-op if not initialized). */
    #save(): void
    {
        if (this.#cwd && this.#sessionId)
        {
            saveStack(this.entries, this.#acknowledgedSequences, this.#cwd, this.#sessionId);
        }
    }

    /** Return the current global or per-file projection, newest first. */
    #projection(filepath?: string): StackEntry[]
    {
        return this.entries
            .filter((entry) => filepath === undefined || entry.filePaths[0] === filepath)
            .sort((a, b) => b.sequence - a.sequence);
    }

    /** Build display entries for a projection ordered most recent first. */
    #buildDisplay(range: StackEntry[]): StackDisplayEntry[]
    {
        return range.map((entry, index) => ({
            id: index + 1,
            sequence: entry.sequence,
            toolName: entry.toolName,
            summary: entry.summary,
            args: entry.args,
            filePaths: entry.filePaths,
            fileCount: 1,
            acknowledged: this.#acknowledgedSequences.has(entry.sequence),
        }));
    }

    /** Compute deterministic content hash for an entry. */
    static computeHash(entry: Pick<StackEntry, "toolName" | "fileDiffs" | "createdFiles">): string
    {
        const h = createHash("sha256");
        h.update(entry.toolName);

        for (const fd of [...entry.fileDiffs].sort((a, b) => a.path.localeCompare(b.path)))
        {
            h.update("\u0000diff\u0000");
            h.update(fd.path);
            h.update("\u0000");
            h.update(fd.diff);
        }

        for (const cf of [...entry.createdFiles].sort())
        {
            h.update("\u0000create\u0000");
            h.update(cf);
        }

        return h.digest("hex").slice(0, 12);
    }

    /** Get the flat global history or a single file's local history. */
    viewStack(filepath?: string): StackDisplayEntry[]
    {
        return this.#buildDisplay(this.#projection(filepath));
    }

    /** Number of entries in the global history. */
    get size(): number
    {
        return this.entries.length;
    }

    /**
     * Undo the newest N entries globally or in one file.
     * N=1 executes immediately. N>1 uses a preview/confirmation guard.
     */
    async undo(steps: number, filepath?: string): Promise<UndoResult>
    {
        if (steps <= 0)
        {
            return { kind: "noop", text: "undo: nothing to do (steps=0)" };
        }

        const projection = this.#projection(filepath);

        if (steps > projection.length)
        {
            const scope = filepath === undefined ? "stack" : `stack for ${filepath}`;
            return {
                kind: "error",
                text: `undo: ${scope} has ${projection.length} entries, requested ${steps}`,
            };
        }

        const range = projection.slice(0, steps);

        if (steps === 1)
        {
            this.#pendingPreview = null;
            return await this.#execute(range);
        }

        const sequences = range.map((entry) => entry.sequence);
        const pending = this.#pendingPreview;
        const pendingMatches = pending !== null
            && pending.steps === steps
            && pending.filepath === filepath
            && pending.sequences.length === sequences.length
            && pending.sequences.every((sequence, index) => sequence === sequences[index]);

        if (
            pendingMatches
            || (pending === null && sequences.every((sequence) => this.#acknowledgedSequences.has(sequence)))
        )
        {
            this.#pendingPreview = null;
            return await this.#execute(range);
        }

        this.#pendingPreview = { filepath, steps, sequences };

        for (const sequence of sequences)
        {
            this.#acknowledgedSequences.add(sequence);
        }

        this.#save();

        return this.#buildPreview(range, sequences, filepath);
    }

    /** Execute undo for the exact selected entries. */
    async #execute(range: StackEntry[]): Promise<UndoResult>
    {
        const selectedSequences = new Set(range.map((entry) => entry.sequence));
        this.entries = this.entries.filter((entry) => !selectedSequences.has(entry.sequence));
        const lines: string[] = [];

        // Revert newest entries first. For one file this leaves the oldest pre-state on disk.
        for (const entry of range)
        {
            for (const snap of entry.snapshots)
            {
                await restoreSnapshot(snap);
            }

            for (const filePath of entry.createdFiles)
            {
                await deleteFile(filePath);
            }

            lines.push(`\u21A9 ${entry.toolName}: ${entry.summary}  ${entry.filePaths[0]}`);
            this.#acknowledgedSequences.delete(entry.sequence);
        }

        this.#save();

        return {
            kind: "executed",
            text: [
                `UNDONE: ${range.length} operation(s) reverted`,
                ...lines,
                `stack: ${this.entries.length} entries remaining`,
            ].join("\n"),
        };
    }

    /** Build a preview for a selected global or local range. */
    #buildPreview(
        range: StackEntry[],
        unacknowledgedSequences: number[],
        filepath?: string,
    ): UndoResult
    {
        const displayEntries = this.#buildDisplay(range);
        const fileDiffs: Record<number, { path: string; diff: string; }[]> = {};

        for (const entry of range)
        {
            if (unacknowledgedSequences.includes(entry.sequence))
            {
                fileDiffs[entry.sequence] = entry.fileDiffs;
            }
        }

        const textLines: string[] = [];
        const scope = filepath === undefined ? "" : ` for ${filepath}`;
        textLines.push(`\u23EE undo ${range.length}${scope} — preview`);
        textLines.push("");

        for (const de of displayEntries)
        {
            const mark = de.acknowledged ? "\u2713" : "\u2717";
            const note = de.acknowledged ? "" : " — new";
            textLines.push(`  ${de.id}\u2502 ${de.toolName}  ${de.summary}  ${de.filePaths[0]}  ${mark}${note}`);
        }

        for (const sequence of unacknowledgedSequences)
        {
            const diffs = fileDiffs[sequence];

            if (!diffs)
            {
                continue;
            }

            for (const diff of diffs)
            {
                textLines.push("");
                textLines.push(`  \u2500\u2500 ${diff.path} \u2500\u2500`);
                textLines.push(diff.diff);
            }
        }

        textLines.push("");
        const filepathArg = filepath === undefined ? "" : `, filepath: "${filepath}"`;
        textLines.push(`Call undo(steps: ${range.length}${filepathArg}) to confirm execution.`);

        return {
            kind: "preview",
            text: textLines.join("\n"),
            preview: {
                entries: displayEntries,
                unacknowledgedSequences,
                fileDiffs,
            },
        };
    }
}

/** Singleton instance. */
const stackStore = new StackStore();

export { StackStore, stackStore };

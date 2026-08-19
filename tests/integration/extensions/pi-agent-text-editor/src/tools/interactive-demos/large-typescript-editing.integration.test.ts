import { readFile } from "node:fs/promises";
import path from "node:path";

import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import {
    assistantMessage,
    getToolExecution,
    getToolExecutionDetails,
    PiIntegrationTest,
    text,
    toolCall,
} from "pi-coding-agent-test";
import { afterAll, describe, expect, test } from "vitest";

import { createExtensionSet } from "#integration/support/pi-runtime/extension-set.js";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.js";
import { getTextToolMutationData } from "#integration/support/pi-runtime/scenario.js";

const extensions = createExtensionSet();
const sourceFile = path.resolve("tests/integration/extensions/pi-agent-text-editor/src/tools/interactive-demos/fixtures/stack-store.ts");
const defaultTextEditorExtension =
    path.resolve("tests/integration/extensions/pi-agent-text-editor/register-extension.ts");
const rendererTestStand =
    path.resolve("tests/integration/extensions/pi-agent-text-editor/plugins/pi-agent-text-editor-renderer/register-extension.ts");
const demoFileName = "stack-store-demo.ts";
const interactivePacing = process.env.PI_INTEGRATION_TEST_LIVE === "1"
    ? {}
    : { chunks: { kind: "fixed" as const, size: 256 }, delayMs: 0 };

afterAll(() => extensions.dispose());

interface EditPlan
{
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly after: string;
}

const searchMethods = [
    "    /** Find the newest entry matching an exact content hash. */",
    "    findByHash(hash: string): StackEntry | undefined",
    "    {",
    "        return [...this.entries]",
    "            .reverse()",
    "            .find((entry) => StackStore.computeHash(entry) === hash);",
    "    }",
    "",
    "    /** Return entries for one tool without exposing the mutable store. */",
    "    entriesForTool(toolName: string): readonly StackEntry[]",
    "    {",
    "        return this.entries",
    "            .filter((entry) => entry.toolName === toolName)",
    "            .sort((left, right) => right.sequence - left.sequence);",
    "    }",
    "",
    "    /** Remove acknowledgements which no longer point at a stored entry. */",
    "    #pruneAcknowledgements(): void",
    "    {",
    "        const activeSequences = new Set(this.entries.map((entry) => entry.sequence));",
    "",
    "        for (const sequence of this.#acknowledgedSequences)",
    "        {",
    "            if (!activeSequences.has(sequence))",
    "            {",
    "                this.#acknowledgedSequences.delete(sequence);",
    "            }",
    "        }",
    "    }",
].join("\n");

const computeHashReplacement = [
    "    /** Compute a deterministic hash from every persisted part of an entry. */",
    "    static computeHash(entry: Pick<StackEntry, \"toolName\" | \"fileDiffs\" | \"createdFiles\">): string",
    "    {",
    "        const hash = createHash(\"sha256\");",
    "        const writeField = (label: string, value: string): void =>",
    "        {",
    "            hash.update(label);",
    "            hash.update(\"\\u0000\");",
    "            hash.update(String(Buffer.byteLength(value, \"utf8\")));",
    "            hash.update(\"\\u0000\");",
    "            hash.update(value);",
    "            hash.update(\"\\u0000\");",
    "        };",
    "",
    "        writeField(\"tool\", entry.toolName);",
    "",
    "        for (const fileDiff of [...entry.fileDiffs].sort((left, right) => left.path.localeCompare(right.path)))",
    "        {",
    "            writeField(\"diff-path\", fileDiff.path);",
    "            writeField(\"diff-content\", fileDiff.diff);",
    "        }",
    "",
    "        for (const createdFile of [...entry.createdFiles].sort((left, right) => left.localeCompare(right)))",
    "        {",
    "            writeField(\"created-file\", createdFile);",
    "        }",
    "",
    "        return hash.digest(\"hex\").slice(0, 16);",
    "    }",
].join("\n");

const undoReplacement = [
    "    /** Undo the newest entries globally or for one file. */",
    "    async undo(steps: number, filepath?: string): Promise<UndoResult>",
    "    {",
    "        if (!Number.isSafeInteger(steps) || steps < 0)",
    "        {",
    "            return { kind: \"error\", text: `undo: steps must be a non-negative integer, received ${steps}` };",
    "        }",
    "",
    "        if (steps === 0)",
    "        {",
    "            return { kind: \"noop\", text: \"undo: nothing to do (steps=0)\" };",
    "        }",
    "",
    "        const projection = this.#projection(filepath);",
    "",
    "        if (steps > projection.length)",
    "        {",
    "            const scope = filepath === undefined ? \"stack\" : `stack for ${filepath}`;",
    "            return {",
    "                kind: \"error\",",
    "                text: `undo: ${scope} has ${projection.length} entries, requested ${steps}`,",
    "            };",
    "        }",
    "",
    "        const selected = projection.slice(0, steps);",
    "",
    "        if (steps === 1)",
    "        {",
    "            this.#pendingPreview = null;",
    "            return await this.#execute(selected);",
    "        }",
    "",
    "        const sequences = selected.map((entry) => entry.sequence);",
    "        const preview = this.#pendingPreview;",
    "        const matchesPreview = preview !== null",
    "            && preview.steps === steps",
    "            && preview.filepath === filepath",
    "            && preview.sequences.length === sequences.length",
    "            && preview.sequences.every((sequence, index) => sequence === sequences[index]);",
    "        const alreadyAcknowledged = preview === null",
    "            && sequences.every((sequence) => this.#acknowledgedSequences.has(sequence));",
    "",
    "        if (matchesPreview || alreadyAcknowledged)",
    "        {",
    "            this.#pendingPreview = null;",
    "            return await this.#execute(selected);",
    "        }",
    "",
    "        this.#pendingPreview = { filepath, steps, sequences };",
    "",
    "        for (const sequence of sequences)",
    "        {",
    "            this.#acknowledgedSequences.add(sequence);",
    "        }",
    "",
    "        this.#pruneAcknowledgements();",
    "        this.#save();",
    "        return this.#buildPreview(selected, sequences, filepath);",
    "    }",
].join("\n");

const displayReplacement = [
    "    /** Build immutable display entries for a newest-first projection. */",
    "    #buildDisplay(range: readonly StackEntry[]): StackDisplayEntry[]",
    "    {",
    "        return range.map((entry, index) =>",
    "        {",
    "            const acknowledged = this.#acknowledgedSequences.has(entry.sequence);",
    "",
    "            return {",
    "                id: index + 1,",
    "                sequence: entry.sequence,",
    "                toolName: entry.toolName,",
    "                summary: entry.summary,",
    "                args: { ...entry.args },",
    "                filePaths: [...entry.filePaths],",
    "                fileCount: entry.filePaths.length,",
    "                acknowledged,",
    "            };",
    "        });",
    "    }",
].join("\n");

const viewStackReplacement = [
    "    /** Get a stable page from the global history or one file's local history. */",
    "    viewStack(filepath?: string, offset = 0, limit = 50): StackDisplayEntry[]",
    "    {",
    "        if (!Number.isSafeInteger(offset) || offset < 0)",
    "        {",
    "            throw new RangeError(`Stack offset must be a non-negative integer, received ${offset}`);",
    "        }",
    "",
    "        if (!Number.isSafeInteger(limit) || limit <= 0)",
    "        {",
    "            throw new RangeError(`Stack limit must be a positive integer, received ${limit}`);",
    "        }",
    "",
    "        const page = this.#projection(filepath).slice(offset, offset + limit);",
    "        return this.#buildDisplay(page);",
    "    }",
].join("\n");

const importInsertion = [
    "import { isAbsolute, normalize } from \"node:path\";",
    "import { performance } from \"node:perf_hooks\";",
].join("\n");

const exportedUtilities = [
    "",
    "export interface StackStoreSnapshot",
    "{",
    "    readonly capturedAt: number;",
    "    readonly size: number;",
    "    readonly entries: readonly StackDisplayEntry[];",
    "}",
    "",
    "/** Capture a read-only snapshot suitable for diagnostics and interactive views. */",
    "export function captureStackStore(store: StackStore, filepath?: string): StackStoreSnapshot",
    "{",
    "    if (filepath !== undefined && !isAbsolute(filepath))",
    "    {",
    "        throw new TypeError(`Expected an absolute stack filepath, received ${filepath}`);",
    "    }",
    "",
    "    return {",
    "        capturedAt: performance.now(),",
    "        size: store.size,",
    "        entries: store.viewStack(filepath === undefined ? undefined : normalize(filepath)),",
    "    };",
    "}",
].join("\n");

describe("interactive text editor demos", () =>
{
    test("edits a large real TypeScript file through single calls and a mixed batch", async () =>
    {
        await withTempWorkspace(async (directory) =>
        {
            const initialSource = await readFile(sourceFile, "utf8");
            const demoFile = path.join(directory, demoFileName);
            expect(initialSource.split("\n").length).toBeGreaterThanOrEqual(300);

            const hashPlan = replaceUntil(
                initialSource,
                "    /** Compute deterministic content hash for an entry. */",
                "    /** Get the flat global history or a single file's local history. */",
                computeHashReplacement,
                demoFile,
            );
            const searchPlan = insertAfter(hashPlan.after, "    #nextSequence = 1;", searchMethods, demoFile);
            const undoPlan = replaceUntil(
                searchPlan.after,
                "    /**",
                "    /** Execute undo for the exact selected entries. */",
                undoReplacement,
                demoFile,
                "     * Undo the newest N entries globally or in one file.",
            );
            const batchSource = undoPlan.after;
            const displayPlan = replaceUntil(
                batchSource,
                "    /** Build display entries for a projection ordered most recent first. */",
                "    /** Compute a deterministic hash from every persisted part of an entry. */",
                displayReplacement,
                demoFile,
            );
            const importPlan = insertAfter(
                batchSource,
                "import { MAX_STACK_SIZE } from \"./types.js\";",
                importInsertion,
                demoFile,
            );
            const viewPlan = replaceUntil(
                batchSource,
                "    /** Get the flat global history or a single file's local history. */",
                "    /** Number of entries in the global history. */",
                viewStackReplacement,
                demoFile,
            );
            const utilitiesPlan = insertAfter(
                batchSource,
                "export { StackStore, stackStore };",
                exportedUtilities,
                demoFile,
            );
            const expected = applyFinalBatch(batchSource);
            const callIds = [
                "demo-write-large-file",
                "demo-replace-hash-section",
                "demo-insert-search-api",
                "demo-replace-undo-flow",
                "demo-batch-replace-display",
                "demo-batch-insert-imports",
                "demo-batch-replace-view",
                "demo-batch-insert-utilities",
            ];

            const result = await new PiIntegrationTest({
                testName: "interactive-demo-large-typescript-editing",
                cwd: directory,
                extensions: extensions.paths.map((extension) =>
                    extension === defaultTextEditorExtension ? rendererTestStand : extension
                ),
                tools: ["write", "replace", "insert", "read"],
                rawMode: false,
                timeoutMs: 180_000,
                conversation: [
                    assistantMessage([
                        toolCall({
                            id: callIds[0]!,
                            name: "write",
                            arguments: { path: demoFile, content: initialSource },
                            chunks: { kind: "fixed", size: 512 },
                            delayMs: 0,
                        }),
                    ], { stopReason: "toolUse" }),
                    singleCall(callIds[1]!, "replace", hashPlan.arguments),
                    singleCall(callIds[2]!, "insert", searchPlan.arguments),
                    singleCall(callIds[3]!, "replace", undoPlan.arguments),
                    assistantMessage([
                        pacedToolCall(callIds[4]!, "replace", displayPlan.arguments),
                        pacedToolCall(callIds[5]!, "insert", importPlan.arguments),
                        pacedToolCall(callIds[6]!, "replace", viewPlan.arguments),
                        pacedToolCall(callIds[7]!, "insert", utilitiesPlan.arguments),
                    ], { stopReason: "toolUse" }),
                    assistantMessage([text("The large TypeScript editing demo is complete", { delayMs: 0 })]),
                ],
            }).run("Refactor the stack store through realistic large edits");

            for (const callId of callIds)
            {
                expect(getToolExecution(result, callId).isError, callId).toBe(false);
            }

            const finalMutation = getTextToolMutationData(
                getToolExecutionDetails(getToolExecution(result, callIds.at(-1)!)),
            );
            expect(finalMutation.afterContent).toBe(expected);
        });
    }, 180_000);
});

function singleCall(id: string, name: "replace" | "insert", arguments_: Readonly<Record<string, unknown>>)
{
    return assistantMessage([pacedToolCall(id, name, arguments_)], { stopReason: "toolUse" });
}

function pacedToolCall(id: string, name: "replace" | "insert", arguments_: Readonly<Record<string, unknown>>)
{
    return toolCall({ id, name, arguments: { ...arguments_ }, ...interactivePacing });
}

function replaceUntil(
    source: string,
    startLine: string,
    nextSectionLine: string,
    replacement: string,
    file: string,
    startContextLine?: string,
): EditPlan
{
    const lines = source.split("\n");
    const contextIndex = startContextLine === undefined ? -1 : requiredLine(lines, startContextLine);
    const startIndex = requiredLine(lines, startLine, contextIndex < 0 ? 0 : contextIndex - 1);
    const nextIndex = requiredLine(lines, nextSectionLine, startIndex + 1);
    const endIndex = lines[nextIndex - 1] === "" ? nextIndex - 2 : nextIndex - 1;
    const afterLines = [...lines];
    afterLines.splice(startIndex, endIndex - startIndex + 1, ...replacement.split("\n"));

    return {
        arguments: {
            path: file,
            start: formatLineHashAnchor(startIndex + 1, lines[startIndex]!),
            end: formatLineHashAnchor(endIndex + 1, lines[endIndex]!),
            text: replacement,
        },
        after: afterLines.join("\n"),
    };
}

function insertAfter(source: string, anchorLine: string, insertion: string, file: string): EditPlan
{
    const lines = source.split("\n");
    const anchorIndex = requiredLine(lines, anchorLine);
    const afterLines = [...lines];
    afterLines.splice(anchorIndex + 1, 0, ...insertion.split("\n"));

    return {
        arguments: {
            path: file,
            anchor: formatLineHashAnchor(anchorIndex + 1, lines[anchorIndex]!),
            text: insertion,
        },
        after: afterLines.join("\n"),
    };
}

function requiredLine(lines: readonly string[], expected: string, fromIndex = 0): number
{
    const index = lines.indexOf(expected, fromIndex);

    if (index === -1)
    {
        throw new Error(`Cannot find demo source line: ${expected}`);
    }

    return index;
}

function applyFinalBatch(source: string): string
{
    const withDisplay = replaceUntil(
        source,
        "    /** Build display entries for a projection ordered most recent first. */",
        "    /** Compute a deterministic hash from every persisted part of an entry. */",
        displayReplacement,
        demoFileName,
    ).after;
    const withImports = insertAfter(
        withDisplay,
        "import { MAX_STACK_SIZE } from \"./types.js\";",
        importInsertion,
        demoFileName,
    ).after;
    const withView = replaceUntil(
        withImports,
        "    /** Get the flat global history or a single file's local history. */",
        "    /** Number of entries in the global history. */",
        viewStackReplacement,
        demoFileName,
    ).after;
    return insertAfter(withView, "export { StackStore, stackStore };", exportedUtilities, demoFileName).after;
}

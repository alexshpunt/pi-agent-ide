import { type AgentToolResult, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import { createReadResultRenderer } from "#src/core/tools/read/read-renderer.js";

import type { ReadResultDetails, ReadTextLine } from "#src/api/tools/read.js";

const plainTheme = {
    bold: (text: string): string => text,
    fg: (_color: string, text: string): string => text,
} as Theme;

initTheme("dark", false);

test("renders canonical content and expands the complete saved result", () =>
{
    const lines: ReadTextLine[] = Array.from({ length: 15 }, (_, index) => ({
        lineNumber: index + 1,
        content: index === 0
            ? "clean line 1  <!-- scope-begin-DEAD -->"
            : `clean line ${String(index + 1)}`,
        lineEnding: index === 14 ? "" : "\n",
        presentation: { prefix: `${String(index + 1)}#HASH|`, suffix: " <!-- agent hint -->" },
    }));
    const result: AgentToolResult<ReadResultDetails> = {
        content: [{
            type: "text",
            text: lines.map((line) => `${line.presentation?.prefix}${line.content}${line.presentation?.suffix}`).join(
                "\n",
            ),
        }],
        details: {
            source: "/workspace/notes.txt",
            resolvedBy: "example-source",
            startLine: 1,
            endLine: 15,
            totalLines: 15,
            lines,
        },
    };
    const renderer = createReadResultRenderer({ kind: "code-view" });
    const compact = renderer(
        result,
        { expanded: false, isPartial: false },
        plainTheme,
        { isError: false, lastComponent: undefined } as never,
    );
    const compactText = compact.render(80).join("\n");

    expect(compactText).toContain("clean line 1");
    expect(compactText).not.toContain("#HASH");
    expect(compactText).not.toContain("agent hint");
    expect(compactText).not.toContain("scope-begin");
    expect(compactText).toContain("4 more rows");
    expect(compactText).toContain("to expand");

    const expanded = renderer(
        result,
        { expanded: true, isPartial: false },
        plainTheme,
        { isError: false, lastComponent: compact } as never,
    );
    const expandedText = expanded.render(80).join("\n");

    expect(expanded).toBe(compact);
    expect(expandedText).toContain("clean line 15");
    expect(expandedText).not.toContain("more rows");
});

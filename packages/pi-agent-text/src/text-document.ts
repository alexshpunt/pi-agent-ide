import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

import { type PresentedTextRow, renderPresentedTextRows, type TextChangeMarker } from "./presented-text.js";

export interface TextLinePresentation
{
    readonly prefix?: string;
    readonly suffix?: string;
    readonly marker?: TextChangeMarker;
    readonly before?: readonly PresentedTextRow[];
    readonly after?: readonly PresentedTextRow[];
}

export interface TextLine
{
    readonly lineNumber: number;
    readonly content: string;
    readonly lineEnding: string;
    readonly presentation?: TextLinePresentation;
    readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface TextDocument
{
    readonly source: string;
    readonly content: string;
    readonly lines: readonly TextLine[];
}

export interface TextPresentationContext
{
    readonly purpose: "read" | "edit-diff";
    readonly source: string;
    readonly cwd: string;
    readonly resolvedBy: string;
    readonly signal?: AbortSignal;
}

export interface TextLinePresenter
{
    readonly id: string;
    present(document: TextDocument, context: TextPresentationContext): TextDocument | Promise<TextDocument>;
}

export interface TextPresenterRegistration
{
    readonly presenter: TextLinePresenter;
    readonly priority?: number;
}

const functionSchema = Type.Function([], Type.Unknown());
const presenterSchema = Type.Object({
    id: Type.String({ minLength: 1 }),
    present: functionSchema,
});
const registrationSchema = Type.Object({
    presenter: presenterSchema,
    priority: Type.Optional(Type.Number()),
});

export function isTextLinePresenter(value: unknown): value is TextLinePresenter
{
    return safeCheck(presenterSchema, value);
}

export function isTextPresenterRegistration(value: unknown): value is TextPresenterRegistration
{
    return safeCheck(registrationSchema, value);
}

export function createTextDocument(source: string, content: string): TextDocument
{
    return { source, content, lines: splitTextLines(content) };
}

export function renderTextDocument(document: TextDocument): string
{
    return document.lines.map((line) => `${line.content}${line.lineEnding}`).join("");
}

export function renderPresentedTextDocument(document: TextDocument): string
{
    const rows = document.lines.flatMap((line) => [
        ...(line.presentation?.before ?? []),
        presentedRowFor(line),
        ...(line.presentation?.after ?? []),
    ]);
    const rendered = renderPresentedTextRows(rows);
    let rowIndex = 0;

    return document.lines.map((line) =>
    {
        const lineRowCount = 1 + (line.presentation?.before?.length ?? 0) + (line.presentation?.after?.length ?? 0);
        const output = rendered.slice(rowIndex, rowIndex + lineRowCount).join("\n");
        rowIndex += lineRowCount;
        return `${output}${line.lineEnding}`;
    }).join("");
}

function presentedRowFor(line: TextLine): PresentedTextRow
{
    return {
        content: line.content,
        ...(line.presentation?.prefix === undefined ? {} : { prefix: line.presentation.prefix }),
        ...(line.presentation?.suffix === undefined ? {} : { suffix: line.presentation.suffix }),
        ...(line.presentation?.marker === undefined ? {} : { marker: line.presentation.marker }),
    };
}

function splitTextLines(content: string): TextLine[]
{
    if (content.length === 0)
    {
        return [];
    }

    const lines: TextLine[] = [];
    const pattern = /([^\r\n]*)(\r\n|\r|\n|$)/gu;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null)
    {
        if (match[0].length === 0)
        {
            break;
        }

        lines.push({
            lineNumber: lines.length + 1,
            content: match[1] ?? "",
            lineEnding: match[2] ?? "",
        });
    }

    return lines;
}

function safeCheck(schema: TSchema, value: unknown): boolean
{
    try
    {
        return Value.Check(schema, value);
    }
    catch
    {
        return false;
    }
}

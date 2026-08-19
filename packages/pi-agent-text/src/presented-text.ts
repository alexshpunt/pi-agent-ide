export type TextChangeMarker = " " | "+" | "-";

export interface PresentedTextRow
{
    readonly content: string;
    readonly prefix?: string;
    readonly suffix?: string;
    readonly marker?: TextChangeMarker;
}

export function renderPresentedTextRows(rows: readonly PresentedTextRow[]): string[]
{
    const hasMarkerColumn = rows.some((row) => row.marker !== undefined);

    if (!hasMarkerColumn)
    {
        return rows.map((row) => `${row.prefix ?? ""}${row.content}${row.suffix ?? ""}`);
    }

    const prefixWidth = Math.max(0, ...rows.map((row) => row.prefix?.length ?? 0));
    return rows.map((row) =>
        `${row.marker ?? " "}|${(row.prefix ?? "").padStart(prefixWidth, " ")}${row.content}${row.suffix ?? ""}`
    );
}

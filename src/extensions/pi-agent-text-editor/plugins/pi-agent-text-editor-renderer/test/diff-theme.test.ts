import { describe, expect, test } from "vitest";

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

import { createDiffThemePalette, type DiffThemeTone } from "#src/diff-theme.js";

interface Rgb
{
    readonly red: number;
    readonly green: number;
    readonly blue: number;
}

interface ThemeFixture
{
    readonly background: string;
    readonly added: string;
    readonly removed: string;
    readonly modified: string;
}

const ESCAPE = "\u001B[";

function themeFixture(fixture: ThemeFixture): Theme
{
    const foregrounds: Partial<Record<ThemeColor, string>> = {
        toolDiffAdded: fixture.added,
        toolDiffRemoved: fixture.removed,
        warning: fixture.modified,
        success: fixture.added,
        error: fixture.removed,
        text: fixture.background === "#20252b" ? "#d4d4d4" : "#1f2328",
    };

    return {
        getFgAnsi: (color: ThemeColor) => foregroundAnsi(foregrounds[color] ?? "#808080"),
        getBgAnsi: () => backgroundAnsi(fixture.background),
        getColorMode: () => "truecolor" as const,
    } as unknown as Theme;
}

function indexedThemeFixture(): Theme
{
    const foregrounds: Partial<Record<ThemeColor, number>> = {
        toolDiffAdded: 143,
        toolDiffRemoved: 167,
        toolDiffContext: 244,
        success: 143,
        error: 167,
        warning: 226,
    };

    return {
        getFgAnsi: (color: ThemeColor) => `${ESCAPE}38;5;${foregrounds[color] ?? 244}m`,
        getBgAnsi: () => `${ESCAPE}48;5;22m`,
        getColorMode: () => "256color" as const,
    } as unknown as Theme;
}

function foregroundAnsi(hex: string): string
{
    const { red, green, blue } = rgb(hex);
    return `${ESCAPE}38;2;${red};${green};${blue}m`;
}

function backgroundAnsi(hex: string): string
{
    const { red, green, blue } = rgb(hex);
    return `${ESCAPE}48;2;${red};${green};${blue}m`;
}

function rgb(hex: string): Rgb
{
    return {
        red: Number.parseInt(hex.slice(1, 3), 16),
        green: Number.parseInt(hex.slice(3, 5), 16),
        blue: Number.parseInt(hex.slice(5, 7), 16),
    };
}

function ansiRgb(ansi: string): Rgb
{
    const truecolor = /\u001B\[(?:38|48);2;(\d+);(\d+);(\d+)m/u.exec(ansi);

    if (truecolor !== null)
    {
        return { red: Number(truecolor[1]), green: Number(truecolor[2]), blue: Number(truecolor[3]) };
    }

    const indexed = /\u001B\[(?:38|48);5;(\d+)m/u.exec(ansi);

    if (indexed === null)
    {
        throw new Error(`Expected a color ANSI sequence, received ${JSON.stringify(ansi)}`);
    }

    return indexedRgb(Number(indexed[1]));
}

function indexedRgb(index: number): Rgb
{
    if (index < 16)
    {
        throw new Error(`Expected a derived ANSI-256 color, received base index ${index}`);
    }

    if (index < 232)
    {
        const cube = index - 16;
        const channel = (value: number): number => value === 0 ? 0 : 55 + value * 40;
        return {
            red: channel(Math.floor(cube / 36)),
            green: channel(Math.floor((cube % 36) / 6)),
            blue: channel(cube % 6),
        };
    }

    const gray = 8 + (index - 232) * 10;
    return { red: gray, green: gray, blue: gray };
}

function luminance(color: Rgb): number
{
    const linear = (channel: number): number =>
    {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };

    return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue);
}

function contrast(left: Rgb, right: Rgb): number
{
    const brightest = Math.max(luminance(left), luminance(right));
    const darkest = Math.min(luminance(left), luminance(right));
    return (brightest + 0.05) / (darkest + 0.05);
}

function saturation(color: Rgb): number
{
    const channels = [color.red, color.green, color.blue].map((channel) => channel / 255);
    const maximum = Math.max(...channels);
    const minimum = Math.min(...channels);
    const lightness = (maximum + minimum) / 2;
    const delta = maximum - minimum;
    return delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
}

function expectRestrainedTone(tone: DiffThemeTone, base: Rgb): void
{
    const foreground = ansiRgb(tone.foreground);
    const background = ansiRgb(tone.background);

    expect(saturation(foreground)).toBeLessThanOrEqual(0.72);
    expect(saturation(background)).toBeLessThanOrEqual(0.58);
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(3);
    expect(Math.abs(luminance(background) - luminance(base))).toBeGreaterThan(0.01);
}

describe("diff theme palette", () =>
{
    test("keeps theme semantics while restraining neon dark-theme colors", () =>
    {
        const base = rgb("#20252b");
        const palette = createDiffThemePalette(
            themeFixture({
                background: "#20252b",
                added: "#00ff00",
                removed: "#ff0033",
                modified: "#ffff00",
            }),
            false,
        );

        expectRestrainedTone(palette.added, base);
        expectRestrainedTone(palette.removed, base);
        expectRestrainedTone(palette.modified, base);

        const added = ansiRgb(palette.added.background);
        const removed = ansiRgb(palette.removed.background);
        const modified = ansiRgb(palette.modified.background);
        expect(added.green).toBeGreaterThan(Math.max(added.red, added.blue));
        expect(removed.red).toBeGreaterThan(Math.max(removed.green, removed.blue));
        expect(Math.min(modified.red, modified.green)).toBeGreaterThan(modified.blue);

        const highlight = ansiRgb(palette.modified.emphasisBackground);
        expect(luminance(highlight)).toBeGreaterThan(luminance(modified));
        expect(saturation(highlight)).toBeLessThanOrEqual(0.65);
    });

    test("reverses background contrast for a light theme and respects ANSI-256 mode", () =>
    {
        const base = rgb("#edf0f2");
        const truecolor = createDiffThemePalette(
            themeFixture({
                background: "#edf0f2",
                added: "#588458",
                removed: "#aa5555",
                modified: "#9a7326",
            }),
            false,
        );

        for (const tone of [truecolor.added, truecolor.removed, truecolor.modified])
        {
            expect(luminance(ansiRgb(tone.background))).toBeLessThan(luminance(base));
            expect(contrast(ansiRgb(tone.foreground), ansiRgb(tone.background))).toBeGreaterThanOrEqual(3);
        }

        expect(luminance(ansiRgb(truecolor.modified.emphasisBackground)))
            .toBeLessThan(luminance(ansiRgb(truecolor.modified.background)));

        const indexed = createDiffThemePalette(indexedThemeFixture(), false);
        expect(indexed.added.foreground).toMatch(/^\u001B\[38;5;\d+m$/u);
        expect(indexed.added.background).toMatch(/^\u001B\[48;5;\d+m$/u);
        expect(indexed.modified.emphasisBackground).toMatch(/^\u001B\[48;5;\d+m$/u);
        expect(
            new Set([
                indexed.added.background,
                indexed.removed.background,
                indexed.modified.background,
            ]).size,
        ).toBe(3);
        const indexedAdded = ansiRgb(indexed.added.background);
        const indexedRemoved = ansiRgb(indexed.removed.background);
        const indexedModified = ansiRgb(indexed.modified.background);
        expect(indexedAdded.green).toBeGreaterThanOrEqual(indexedAdded.red);
        expect(indexedAdded.green).toBeGreaterThan(indexedAdded.blue);
        expect(indexedRemoved.red).toBeGreaterThan(Math.max(indexedRemoved.green, indexedRemoved.blue));
        expect(Math.min(indexedModified.red, indexedModified.green)).toBeGreaterThan(indexedModified.blue);

        for (const tone of [indexed.added, indexed.removed, indexed.modified])
        {
            expect(contrast(ansiRgb(tone.foreground), ansiRgb(tone.background))).toBeGreaterThanOrEqual(3);
        }

        expect(saturation(ansiRgb(indexed.modified.emphasisBackground))).toBeGreaterThan(saturation(indexedModified));
        expect(indexed.modified.emphasisBackground).not.toBe(indexed.modified.background);
    });
});

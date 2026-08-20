import { requiredValue } from "../../../../../utils/required-value.js";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

interface Rgb {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

interface Oklab {
  readonly lightness: number;
  readonly a: number;
  readonly b: number;
}

type UnitRgb = readonly [red: number, green: number, blue: number];
type ColorMode = ReturnType<Theme["getColorMode"]>;
type AnsiLayer = 38 | 48;

export interface DiffThemeTone {
  readonly foreground: string;
  readonly background: string;
  readonly emphasisBackground: string;
}

export interface DiffThemePalette {
  readonly added: DiffThemeTone;
  readonly removed: DiffThemeTone;
  readonly modified: DiffThemeTone;
  readonly contextForeground: string;
  readonly restoreBackground: string;
}

const ROW_LIGHTNESS_DELTA = 0.055;
const EMPHASIS_LIGHTNESS_DELTA = 0.115;
const ROW_CHROMA_SCALE = 0.42;
const EMPHASIS_CHROMA_SCALE = 0.58;
const MAX_ROW_CHROMA = 0.045;
const MAX_EMPHASIS_CHROMA = 0.06;
const MAX_FOREGROUND_CHROMA = 0.12;
const DARK_BACKGROUND_THRESHOLD = 0.65;
const MIN_FOREGROUND_CONTRAST = 3;
const ANSI_BACKGROUND_LIGHTNESS_SCALE = 1.6;
const ANSI_BACKGROUND_CHROMA_SCALE = 2;
const CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;
const ANSI_16_COLORS: readonly Rgb[] = [
  { red: 0, green: 0, blue: 0 },
  { red: 128, green: 0, blue: 0 },
  { red: 0, green: 128, blue: 0 },
  { red: 128, green: 128, blue: 0 },
  { red: 0, green: 0, blue: 128 },
  { red: 128, green: 0, blue: 128 },
  { red: 0, green: 128, blue: 128 },
  { red: 192, green: 192, blue: 192 },
  { red: 128, green: 128, blue: 128 },
  { red: 255, green: 0, blue: 0 },
  { red: 0, green: 255, blue: 0 },
  { red: 255, green: 255, blue: 0 },
  { red: 0, green: 0, blue: 255 },
  { red: 255, green: 0, blue: 255 },
  { red: 0, green: 255, blue: 255 },
  { red: 255, green: 255, blue: 255 },
];
const ANSI_CHROMA_WEIGHT = 8;
const ANSI_256_RGB = Array.from({ length: 256 }, (_, index) => ansi256ToRgb(index));
const ANSI_256_OKLAB = ANSI_256_RGB.map((color) => rgbToOklab(color));
const EMPTY_ANSI_INDICES: ReadonlySet<number> = new Set();

export function createDiffThemePalette(theme: Theme, pending: boolean): DiffThemePalette {
  const restoreBackground = theme.getBgAnsi(pending ? "toolPendingBg" : "toolSuccessBg");
  const base = ansiToRgb(restoreBackground) ?? ansiToRgb(theme.getBgAnsi("selectedBg"));
  const mode = theme.getColorMode();
  const reservedBackgrounds = new Set<number>();
  const restoreIndex = ansi256Index(restoreBackground);

  if (restoreIndex !== undefined) {
    reservedBackgrounds.add(restoreIndex);
  }

  const added = createTone(
    semanticForeground(theme, "toolDiffAdded", "success"),
    base,
    restoreBackground,
    mode,
    reservedBackgrounds,
  );
  const removed = createTone(
    semanticForeground(theme, "toolDiffRemoved", "error"),
    base,
    restoreBackground,
    mode,
    reservedBackgrounds,
  );
  const modified = createTone(
    theme.getFgAnsi("warning"),
    base,
    restoreBackground,
    mode,
    reservedBackgrounds,
  );

  return {
    added,
    removed,
    modified,
    contextForeground: theme.getFgAnsi("toolDiffContext"),
    restoreBackground,
  };
}

function semanticForeground(theme: Theme, primary: ThemeColor, fallback: ThemeColor): string {
  const ansi = theme.getFgAnsi(primary);
  return ansiToRgb(ansi) === undefined ? theme.getFgAnsi(fallback) : ansi;
}

function createTone(
  sourceAnsi: string,
  base: Rgb | undefined,
  restore: string,
  mode: ColorMode,
  reservedBackgrounds: Set<number>,
): DiffThemeTone {
  const source = ansiToRgb(sourceAnsi);

  if (base === undefined || source === undefined) {
    return { foreground: sourceAnsi, background: restore, emphasisBackground: restore };
  }

  const baseLab = rgbToOklab(base);
  const sourceLab = rgbToOklab(source);
  const isDark = baseLab.lightness < DARK_BACKGROUND_THRESHOLD;
  const lightnessScale = mode === "256color" ? ANSI_BACKGROUND_LIGHTNESS_SCALE : 1;
  const chromaScale = mode === "256color" ? ANSI_BACKGROUND_CHROMA_SCALE : 1;
  const background = deriveBackground(
    baseLab,
    sourceLab,
    isDark,
    ROW_LIGHTNESS_DELTA * lightnessScale,
    ROW_CHROMA_SCALE * chromaScale,
    MAX_ROW_CHROMA * chromaScale,
  );
  const emphasisBackground = deriveBackground(
    baseLab,
    sourceLab,
    isDark,
    EMPHASIS_LIGHTNESS_DELTA * lightnessScale,
    EMPHASIS_CHROMA_SCALE * chromaScale,
    MAX_EMPHASIS_CHROMA * chromaScale,
  );
  const backgroundAnsi = colorAnsi(background, 48, mode, reservedBackgrounds);
  const backgroundIndex = ansi256Index(backgroundAnsi);

  if (backgroundIndex !== undefined) {
    reservedBackgrounds.add(backgroundIndex);
  }

  const renderedBackground = ansiToRgb(backgroundAnsi) ?? background;
  const foreground = deriveForeground(sourceLab, renderedBackground, isDark);

  return {
    foreground: colorAnsi(foreground, 38, mode, EMPTY_ANSI_INDICES, renderedBackground),
    background: backgroundAnsi,
    emphasisBackground: colorAnsi(emphasisBackground, 48, mode, reservedBackgrounds),
  };
}

function deriveBackground(
  base: Oklab,
  source: Oklab,
  dark: boolean,
  lightnessDelta: number,
  chromaScale: number,
  maximumChroma: number,
): Rgb {
  const sourceChroma = Math.hypot(source.a, source.b);
  const hue = sourceChroma === 0 ? 0 : Math.atan2(source.b, source.a);
  const chroma = Math.min(sourceChroma * chromaScale, maximumChroma);
  const direction = dark ? 1 : -1;
  const lightness = clamp(base.lightness + direction * lightnessDelta, 0.08, 0.97);
  return oklchToRgb(lightness, chroma, hue);
}

function deriveForeground(source: Oklab, background: Rgb, dark: boolean): Rgb {
  const sourceChroma = Math.hypot(source.a, source.b);
  const hue = sourceChroma === 0 ? 0 : Math.atan2(source.b, source.a);
  const chroma = Math.min(sourceChroma, MAX_FOREGROUND_CHROMA);
  let lightness = dark ? clamp(source.lightness, 0.67, 0.86) : clamp(source.lightness, 0.34, 0.62);
  let foreground = oklchToRgb(lightness, chroma, hue);

  for (
    let attempt = 0;
    attempt < 24 && contrast(foreground, background) < MIN_FOREGROUND_CONTRAST;
    attempt++
  ) {
    lightness = clamp(lightness + (dark ? 0.012 : -0.012), 0.12, 0.96);
    foreground = oklchToRgb(lightness, chroma, hue);
  }

  return foreground;
}

function ansiToRgb(ansi: string): Rgb | undefined {
  const sequence = ansi.startsWith("\u{1B}[") ? ansi.slice(2) : ansi;
  const truecolor = /^(?:38|48);2;(\d+);(\d+);(\d+)m$/u.exec(sequence);

  if (truecolor !== null) {
    return {
      red: clampByte(Number(truecolor[1])),
      green: clampByte(Number(truecolor[2])),
      blue: clampByte(Number(truecolor[3])),
    };
  }

  const indexed = ansi256Index(ansi);
  return indexed === undefined ? undefined : ansi256ToRgb(indexed);
}

function ansi256Index(ansi: string): number | undefined {
  const sequence = ansi.startsWith("\u{1B}[") ? ansi.slice(2) : ansi;
  const match = /^(?:38|48);5;(\d+)m$/u.exec(sequence);
  return match === null ? undefined : clamp(Math.round(Number(match[1])), 0, 255);
}

function ansi256ToRgb(index: number): Rgb {
  if (index < 16) {
    return requiredValue(ANSI_16_COLORS[index]);
  }

  if (index < 232) {
    const cube = index - 16;
    return {
      red: requiredValue(CUBE_VALUES[Math.floor(cube / 36)]),
      green: requiredValue(CUBE_VALUES[Math.floor((cube % 36) / 6)]),
      blue: requiredValue(CUBE_VALUES[cube % 6]),
    };
  }

  const gray = 8 + (index - 232) * 10;
  return { red: gray, green: gray, blue: gray };
}

function colorAnsi(
  color: Rgb,
  layer: AnsiLayer,
  mode: ColorMode,
  reserved: ReadonlySet<number> = EMPTY_ANSI_INDICES,
  contrastAgainst?: Rgb,
): string {
  return mode === "256color"
    ? `\u{1B}[${layer};5;${rgbTo256(color, reserved, contrastAgainst)}m`
    : `\u{1B}[${layer};2;${color.red};${color.green};${color.blue}m`;
}

function rgbTo256(color: Rgb, reserved: ReadonlySet<number>, contrastAgainst?: Rgb): number {
  const target = rgbToOklab(color);
  let closestIndex: number | undefined;
  let closestDistance = Infinity;

  for (let index = 16; index < ANSI_256_OKLAB.length; index++) {
    const candidateColor = requiredValue(ANSI_256_RGB[index]);

    if (
      reserved.has(index) ||
      (contrastAgainst !== undefined &&
        contrast(candidateColor, contrastAgainst) < MIN_FOREGROUND_CONTRAST)
    ) {
      continue;
    }

    const candidate = requiredValue(ANSI_256_OKLAB[index]);
    const lightnessDistance = target.lightness - candidate.lightness;
    const aDistance = target.a - candidate.a;
    const bDistance = target.b - candidate.b;
    const distance =
      lightnessDistance ** 2 + ANSI_CHROMA_WEIGHT * (aDistance ** 2 + bDistance ** 2);

    if (distance < closestDistance) {
      closestIndex = index;
      closestDistance = distance;
    }
  }

  return closestIndex ?? (contrastAgainst === undefined ? 16 : rgbTo256(color, reserved));
}

function rgbToOklab(color: Rgb): Oklab {
  const red = srgbToLinear(color.red / 255);
  const green = srgbToLinear(color.green / 255);
  const blue = srgbToLinear(color.blue / 255);
  const l = Math.cbrt(0.412_221_470_8 * red + 0.536_332_536_3 * green + 0.051_445_992_9 * blue);
  const m = Math.cbrt(0.211_903_498_2 * red + 0.680_699_545_1 * green + 0.107_396_956_6 * blue);
  const s = Math.cbrt(0.088_302_461_9 * red + 0.281_718_837_6 * green + 0.629_978_700_5 * blue);

  return {
    lightness: 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s,
    a: 1.977_998_495_1 * l - 2.428_592_205 * m + 0.450_593_709_9 * s,
    b: 0.025_904_037_1 * l + 0.782_771_766_2 * m - 0.808_675_766 * s,
  };
}

function oklchToRgb(lightness: number, chroma: number, hue: number): Rgb {
  let lowerChroma = 0;
  let upperChroma = chroma;
  let best = oklabToSrgb({ lightness, a: 0, b: 0 });

  for (let attempt = 0; attempt < 18; attempt++) {
    const candidateChroma = attempt === 0 ? upperChroma : (lowerChroma + upperChroma) / 2;
    const candidate = oklabToSrgb({
      lightness,
      a: Math.cos(hue) * candidateChroma,
      b: Math.sin(hue) * candidateChroma,
    });

    if (inGamut(candidate)) {
      best = candidate;
      lowerChroma = candidateChroma;

      if (attempt === 0) {
        break;
      }
    } else {
      upperChroma = candidateChroma;
    }
  }

  return {
    red: clampByte(Math.round(best[0] * 255)),
    green: clampByte(Math.round(best[1] * 255)),
    blue: clampByte(Math.round(best[2] * 255)),
  };
}

function oklabToSrgb(color: Oklab): UnitRgb {
  const l = (color.lightness + 0.396_337_777_4 * color.a + 0.215_803_757_3 * color.b) ** 3;
  const m = (color.lightness - 0.105_561_345_8 * color.a - 0.063_854_172_8 * color.b) ** 3;
  const s = (color.lightness - 0.089_484_177_5 * color.a - 1.291_485_548 * color.b) ** 3;
  return [
    linearToSrgb(4.076_741_662_1 * l - 3.307_711_591_3 * m + 0.230_969_929_2 * s),
    linearToSrgb(-1.268_438_004_6 * l + 2.609_757_401_1 * m - 0.341_319_396_5 * s),
    linearToSrgb(-0.004_196_086_3 * l - 0.703_418_614_7 * m + 1.707_614_701 * s),
  ];
}

function inGamut(color: UnitRgb): boolean {
  return color.every((channel) => channel >= 0 && channel <= 1);
}

function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(channel: number): number {
  return channel <= 0.003_130_8 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function contrast(left: Rgb, right: Rgb): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * srgbToLinear(color.red / 255) +
    0.7152 * srgbToLinear(color.green / 255) +
    0.0722 * srgbToLinear(color.blue / 255)
  );
}

function clampByte(value: number): number {
  return clamp(value, 0, 255);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

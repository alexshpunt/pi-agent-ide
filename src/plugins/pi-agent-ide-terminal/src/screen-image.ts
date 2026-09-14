import type { SKRSContext2D } from "@napi-rs/canvas";
import type { IBufferCell } from "@xterm/headless";

import type { TerminalSessionManager } from "#src/plugins/pi-agent-ide-terminal/src/session-manager.js";

const CELL_WIDTH = 9;
const CELL_HEIGHT = 18;
const FONT_SIZE = 14;
const PADDING = 12;
const DEFAULT_FOREGROUND = "#d8dee9";
const DEFAULT_BACKGROUND = "#111418";
const ANSI_16 = [
  "#000000",
  "#cd0000",
  "#00cd00",
  "#cdcd00",
  "#0000ee",
  "#cd00cd",
  "#00cdcd",
  "#e5e5e5",
  "#7f7f7f",
  "#ff0000",
  "#00ff00",
  "#ffff00",
  "#5c5cff",
  "#ff00ff",
  "#00ffff",
  "#ffffff",
] as const;

/** Render the current ANSI-aware virtual terminal screen to a PNG for multimodal agent reads. */
export async function renderTerminalScreen(
  manager: TerminalSessionManager,
  source: string,
  rows?: { readonly start: number; readonly count: number },
): Promise<string> {
  const session = manager.get(source);
  if (session === undefined) throw new Error(`Unknown terminal session ${source}`);
  await session.screenReady;
  const { createCanvas } = await import("@napi-rs/canvas");
  const startRow = Math.max(0, Math.min(session.rows - 1, rows?.start ?? 0));
  const rowCount = Math.max(1, Math.min(session.rows - startRow, rows?.count ?? session.rows));
  const canvas = createCanvas(
    session.cols * CELL_WIDTH + PADDING * 2,
    rowCount * CELL_HEIGHT + PADDING * 2,
  );
  const context = canvas.getContext("2d");
  context.fillStyle = DEFAULT_BACKGROUND;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textBaseline = "top";

  const buffer = session.screen.buffer.active;
  const firstRow = Math.max(0, buffer.baseY);
  for (let row = 0; row < rowCount; row += 1) {
    const line = buffer.getLine(firstRow + startRow + row);
    if (line === undefined) continue;
    for (let column = 0; column < session.cols; column += 1) {
      const cell = line.getCell(column);
      if (cell === undefined || cell.getWidth() === 0) continue;
      drawCell(context, cell, column, row);
    }
  }

  if (
    session.status === "running" &&
    buffer.cursorY >= startRow &&
    buffer.cursorY < startRow + rowCount
  ) {
    context.fillStyle = "rgba(216, 222, 233, 0.75)";
    context.fillRect(
      PADDING + buffer.cursorX * CELL_WIDTH,
      PADDING + (buffer.cursorY - startRow) * CELL_HEIGHT + CELL_HEIGHT - 2,
      CELL_WIDTH,
      2,
    );
  }
  return canvas.toBuffer("image/png").toString("base64");
}

function drawCell(context: SKRSContext2D, cell: IBufferCell, column: number, row: number): void {
  let foreground = cellColor(cell, "foreground");
  let background = cellColor(cell, "background");
  if (cell.isInverse()) [foreground, background] = [background, foreground];
  const x = PADDING + column * CELL_WIDTH;
  const y = PADDING + row * CELL_HEIGHT;
  if (background !== DEFAULT_BACKGROUND) {
    context.fillStyle = background;
    context.fillRect(x, y, CELL_WIDTH * Math.max(1, cell.getWidth()), CELL_HEIGHT);
  }
  const chars = cell.getChars();
  if (chars.length === 0) return;
  context.font = `${cell.isBold() ? "bold " : ""}${FONT_SIZE}px monospace`;
  context.fillStyle = foreground;
  context.fillText(chars, x, y);
  if (cell.isUnderline()) {
    context.fillRect(x, y + CELL_HEIGHT - 2, CELL_WIDTH * Math.max(1, cell.getWidth()), 1);
  }
}

function cellColor(cell: IBufferCell, kind: "foreground" | "background"): string {
  const foreground = kind === "foreground";
  const isDefault = foreground ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return foreground ? DEFAULT_FOREGROUND : DEFAULT_BACKGROUND;
  const isRgb = foreground ? cell.isFgRGB() : cell.isBgRGB();
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  if (isRgb) return `#${value.toString(16).padStart(6, "0")}`;
  return ansiColor(value);
}

function ansiColor(index: number): string {
  const basic = ANSI_16[index];
  if (basic !== undefined) return basic;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgb(level, level, level);
  }
  const cube = Math.max(0, index - 16);
  const red = Math.floor(cube / 36);
  const green = Math.floor((cube % 36) / 6);
  const blue = cube % 6;
  const channel = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
  return rgb(channel(red), channel(green), channel(blue));
}

function rgb(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

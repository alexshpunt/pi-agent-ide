import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import xterm from "@xterm/headless";
import { expect, test } from "vitest";

import { TerminalTextStream } from "#src/plugins/pi-agent-ide-terminal/src/terminal-text.ts";

// Output that Windows PowerShell wrote through a real Windows pseudoconsole (100×30) over SSH.
const captured = JSON.parse(
  readFileSync(new URL("./fixtures/conpty-powershell.json", import.meta.url), "utf8"),
) as Record<string, string>;

const size = { cols: 100, rows: 30 };

/** Lines as a terminal shows them, with soft-wrapped rows joined. */
async function screenLines(data: string): Promise<string[]> {
  const screen = new xterm.Terminal({ ...size, allowProposedApi: true, scrollback: 1000 });
  await new Promise<void>((resolve) => screen.write(data, resolve));
  const buffer = screen.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    const text = line?.translateToString(true) ?? "";
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  screen.dispose();
  return trimmed(lines);
}

function trimmed(lines: readonly string[]): string[] {
  const result = lines.map((line) => line.trimEnd());
  while (result.length > 0 && result.at(-1) === "") result.pop();
  return result;
}

/** Feed the stream in pieces of `chunk` characters, as a pipe may deliver it. */
function text(data: string, chunk = data.length): string {
  const stream = new TerminalTextStream(() => size);
  let out = "";
  for (let index = 0; index < data.length; index += chunk)
    out += stream.write(data.slice(index, index + chunk));
  return out;
}

const textLines = (value: string) => trimmed(value.replaceAll("\r", "").split("\n"));

test.each(Object.keys(captured))(
  "PowerShell output through a pseudoconsole reads line by line as on screen (%s)",
  async (name) => {
    const data = captured[name] ?? "";
    const expected = await screenLines(data);
    expect(textLines(text(data))).toEqual(expected);
    // Sequences cut between chunks give the same text.
    for (const chunk of [1, 3, 7]) expect(text(data, chunk)).toBe(text(data));
  },
);

test("plain line output keeps exactly the text it had without control sequences", () => {
  const data = "build \u001b[1;32mok\u001b[0m\r\nprogress 10%\rprogress 100%\r\n\ttabbed\n";
  expect(text(data)).toBe(stripVTControlCharacters(data));
});

test("erase and cursor-forward pairs inside a line become spaces, at its end nothing", () => {
  expect(text("a\u001b[3X\u001b[3Cb\u001b[5X\u001b[5C\r\n")).toBe("a   b\r\n");
});

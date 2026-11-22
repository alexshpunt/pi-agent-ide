/** Terminal dimensions that cursor positions are measured against. */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

const ESC = "\u001b";
const BEL = "\u0007";

/**
 * Turn a terminal byte stream into append-only plain text that keeps the visible line structure.
 *
 * Removing control sequences is not enough for a Windows pseudoconsole: it writes blank lines as
 * cursor moves (`ESC[6;1H`), spaces as erase-and-advance pairs (`ESC[9X ESC[9C`), and only some
 * line ends as CR LF. This stream follows the cursor row, so a move to a lower row becomes line
 * breaks and a move right within a row becomes spaces once text follows. Moves up, as in a
 * redrawn screen, cannot be expressed in append-only text and only update the tracked position.
 * Sequences split across chunks are kept until they are complete.
 */
export class TerminalTextStream {
  #row = 0;
  #col = 0;
  #wrapPending = false;
  #pendingSpaces = 0;
  #partial = "";

  constructor(private readonly size: () => TerminalSize) {}

  write(data: string): string {
    const input = this.#partial + data;
    this.#partial = "";
    let out = "";
    let index = 0;
    while (index < input.length) {
      const char = input[index] ?? "";
      if (char === ESC || char === "\u009b") {
        const end = sequenceEnd(input, index);
        if (end === undefined) {
          this.#partial = input.slice(index);
          break;
        }
        out += this.#control(input.slice(index, end));
        index = end;
        continue;
      }
      index += char.length;
      if (char === "\n") {
        this.#pendingSpaces = 0;
        this.#lineFeed();
        out += char;
      } else if (char === "\r") {
        this.#pendingSpaces = 0;
        this.#col = 0;
        this.#wrapPending = false;
        out += char;
      } else if (char === "\t" || char === "\b") {
        out += char;
      } else if (char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f) {
        continue;
      } else {
        out += this.#print(char);
      }
    }
    return out;
  }

  #print(char: string): string {
    const { cols } = this.size();
    const prefix = " ".repeat(this.#pendingSpaces);
    this.#pendingSpaces = 0;
    if (this.#wrapPending) {
      this.#lineFeed();
      this.#col = 0;
    }
    this.#col += 1;
    this.#wrapPending = this.#col >= cols;
    if (this.#wrapPending) this.#col = cols - 1;
    return prefix + char;
  }

  #lineFeed(): void {
    this.#row = Math.min(this.#row + 1, this.size().rows - 1);
    this.#wrapPending = false;
  }

  /** Apply a complete escape sequence and return the text it stands for. */
  #control(sequence: string): string {
    const csi = /^(?:\u001b\[|\u009b)([0-?]*)[ -/]*([@-~])$/u.exec(sequence);
    if (!csi) return "";
    const [, parameters = "", final] = csi;
    if (parameters.startsWith("?") || parameters.startsWith(">") || parameters.startsWith("<"))
      return "";
    const values = parameters.split(";").map((value) => Number.parseInt(value, 10));
    const first = Math.max(1, values[0] || 1);
    const second = Math.max(1, values[1] || 1);
    if (final === "H" || final === "f") return this.#moveTo(first - 1, second - 1);
    if (final === "B") return this.#moveTo(this.#row + first, this.#col);
    if (final === "E") return this.#moveTo(this.#row + first, 0);
    if (final === "G") return this.#moveTo(this.#row, first - 1);
    if (final === "d") return this.#moveTo(first - 1, this.#col);
    if (final === "C") {
      this.#pendingSpaces += first;
      this.#col = Math.min(this.#col + first, this.size().cols - 1);
      this.#wrapPending = false;
    } else if (final === "D") {
      this.#pendingSpaces = Math.max(0, this.#pendingSpaces - first);
      this.#col = Math.max(0, this.#col - first);
      this.#wrapPending = false;
    } else if (final === "A" || final === "F") {
      this.#row = Math.max(0, this.#row - first);
      if (final === "F") this.#col = 0;
      this.#pendingSpaces = 0;
      this.#wrapPending = false;
    } else if (final === "J" && (values[0] || 0) >= 2) {
      // A cleared screen starts again at the top; the next downward move adds the lines.
      this.#row = 0;
      this.#pendingSpaces = 0;
    }
    return "";
  }

  #moveTo(row: number, col: number): string {
    const { cols, rows } = this.size();
    const targetRow = Math.min(Math.max(0, row), rows - 1);
    const targetCol = Math.min(Math.max(0, col), cols - 1);
    let out = "";
    if (targetRow > this.#row) {
      out = "\n".repeat(targetRow - this.#row);
      this.#col = 0;
      this.#pendingSpaces = targetCol;
    } else if (targetRow === this.#row && targetCol > this.#col) {
      this.#pendingSpaces += targetCol - this.#col;
    } else {
      this.#pendingSpaces = 0;
    }
    this.#row = targetRow;
    this.#col = targetCol;
    this.#wrapPending = false;
    return out;
  }
}

/** Index after a complete escape sequence starting at `start`, or undefined if it is cut off. */
function sequenceEnd(input: string, start: number): number | undefined {
  if (input[start] === "\u009b") return csiEnd(input, start + 1);
  const kind = input[start + 1];
  if (kind === undefined) return undefined;
  if (kind === "[") return csiEnd(input, start + 2);
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
    // OSC, DCS, APC, PM and SOS end with BEL (OSC only) or ST.
    for (let index = start + 2; index < input.length; index += 1) {
      if (kind === "]" && input[index] === BEL) return index + 1;
      if (input[index] === ESC) {
        if (input[index + 1] === undefined) return undefined;
        if (input[index + 1] === "\\") return index + 2;
      }
    }
    return undefined;
  }
  // Two-byte escapes, optionally with intermediate bytes such as `ESC ( B`.
  let index = start + 1;
  while (index < input.length && /[ -/]/u.test(input[index] ?? "")) index += 1;
  return index < input.length ? index + 1 : undefined;
}

function csiEnd(input: string, from: number): number | undefined {
  for (let index = from; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    if (code < 0x20 || code > 0x7e) return index;
  }
  return undefined;
}

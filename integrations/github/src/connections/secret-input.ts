import { CURSOR_MARKER, Input, renderFakeCursor } from "@earendil-works/pi-tui";

/** Reuse native paste/edit/cursor handling, but never send the entered text to the renderer. */
export class MaskedGithubInput extends Input {
  constructor() {
    super({ prompt: "" });
  }

  override render(width: number): string[] {
    const markers = [CURSOR_MARKER, ...renderFakeCursor("\uE000").split("\uE000")].filter(Boolean);
    return super.render(width).map((line) => {
      let masked = "";
      for (let index = 0; index < line.length;) {
        const marker = markers.find((value) => line.startsWith(value, index));
        if (marker) {
          masked += marker;
          index += marker.length;
          continue;
        }
        const style = /^\x1b\[[0-9;:]*m/u.exec(line.slice(index));
        if (style) {
          masked += style[0];
          index += style[0].length;
          continue;
        }
        const point = line.codePointAt(index);
        if (point === undefined) break;
        const character = String.fromCodePoint(point);
        masked += character === " " ? " " : "•";
        index += character.length;
      }
      return masked;
    });
  }
}

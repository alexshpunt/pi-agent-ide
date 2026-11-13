import { ToolCallArgumentsStream, type JsonObject } from "@earendil-works/pi-ai";

/** Rewrites complete issued tokens while keeping the rest of a tool argument stream progressive. */
export class IssuedArgumentStream {
  private pending = "";
  private readonly parser = new ToolCallArgumentsStream();
  private parsed: JsonObject = {};

  constructor(private readonly substitute: (value: string) => string) {}

  /** Emit safe JSON text; at call completion no more token characters can arrive. */
  push(delta: string, complete = false): string {
    const input = this.pending + delta;
    let boundary = input.length;
    if (!complete) {
      const dollar = input.lastIndexOf("$");
      if (dollar !== -1) {
        const tail = input.slice(dollar);
        if ("$issued-".startsWith(tail) || /^\$issued-[a-z\d:-]*$/u.test(tail)) boundary = dollar;
      }
    }
    this.pending = input.slice(boundary);
    const safe = this.substitute(input.slice(0, boundary));
    this.parsed = this.parser.append(safe);
    if (complete) this.parsed = this.parser.finish().arguments;
    return safe;
  }

  /** Partial arguments contain only JSON text already emitted to the consumer. */
  get arguments(): JsonObject {
    return this.parsed;
  }
}

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Exercise stopped-frame evaluation and late stops through the public debugger tools. */
export default function debuggerStateFixture(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "check_debugger_state",
    label: "Check debugger state",
    description: "Check debugger state through public tools and their returned source anchors.",
    parameters: Type.Object({
      phase: Type.Union([Type.Literal("evaluate"), Type.Literal("late")]),
    }),
    async execute(_id, { phase }, signal, _onUpdate, ctx) {
      const call = async (name: string, args: Record<string, unknown>, callSignal = signal) => {
        const result = await ctx.executeTool(name, args, { signal: callSignal });
        if (result.isError) throw new Error(JSON.stringify(result));
        return result.result;
      };
      const created = await call("debug", { adapter: "debugpy", program: "contract.py" });
      const shown = created.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const source = /debug:[a-f\d]+/u.exec(shown)?.[0];
      if (source === undefined) throw new Error("Debug returned no session");
      try {
        const file = await call("read", { path: `${source}/source`, views: ["anchors"] });
        const sourceText = file.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .replace(/^<system-result[^]*?<\/system-result>\n/u, "");
        const addBreakpoint = async (line: number) => {
          const anchor =
            new RegExp(`(?:^|\\n)(${line}#[A-F\\d]+)\\|`, "u").exec(sourceText)?.[1] ??
            sourceText.split("\n")[line - 1];
          if (anchor === undefined) throw new Error(`Source returned no line-${line} anchor`);
          return call("insert", { path: `${source}/source`, anchor, text: "breakpoint" });
        };
        const pending = await addBreakpoint(phase === "late" ? 2 : 4);
        if (phase === "late") await addBreakpoint(4);
        const started = await call("insert", { path: source, text: "start" });
        if (phase === "late") {
          const interrupted = await ctx.executeTool(
            "insert",
            { path: source, text: "continue" },
            {
              signal: AbortSignal.any([
                ...(signal === undefined ? [] : [signal]),
                AbortSignal.timeout(150),
              ]),
            },
          );
          if (!interrupted.isError) throw new Error("Continue did not reach its interrupted wait");
          await new Promise<void>((resolve) => setTimeout(resolve, 1500));
        }
        const read = await call("read", { path: source });
        const evaluated = await call("insert", {
          path: source,
          text: phase === "evaluate" ? "evaluate (subtotal := subtotal + 1)" : "evaluate subtotal",
        });
        return {
          content: evaluated.content,
          details: {
            pending: pending.details as unknown,
            started: started.details as unknown,
            evaluated: evaluated.details as unknown,
            read: read.content,
          },
        };
      } finally {
        await call("delete", { path: source });
      }
    },
  });
}

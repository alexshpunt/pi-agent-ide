import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Exercise public tools with the ids and anchors they return, without rewriting streamed arguments. */
export default function javaPublicFixture(pi: ExtensionAPI): void {
  let source: string | undefined;
  pi.registerCommand("java-lifecycle-reload", {
    description: "Reload the candidate before checking the Java lifecycle.",
    async handler(_args, ctx) {
      await ctx.reload();
    },
  });
  pi.on("resources_discover", (event) => {
    if (event.reason === "reload")
      pi.sendUserMessage(
        "Debug Main.java at line 4, inspect subtotal, then continue and clean up.",
        { deliverAs: "followUp" },
      );
  });
  pi.registerTool({
    name: "check_java_lifecycle",
    label: "Check Java lifecycle",
    description: "Run the Java lifecycle through public debugger and resource tools.",
    parameters: Type.Object({
      phase: Type.Union([Type.Literal("start"), Type.Literal("continue")]),
    }),
    async execute(_id, { phase }, signal, _onUpdate, ctx) {
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await ctx.executeTool(name, args, { signal });
        if (result.isError) throw new Error(JSON.stringify(result));
        return result.result;
      };
      if (phase === "start") {
        const created = await call("debug", {
          adapter: "java",
          program: "src/main/java/Main.java",
          mainClass: "Main",
        });
        const resource = created.structuredContent as { data?: { source?: string } } | undefined;
        source = resource?.data?.source;
        if (source === undefined)
          throw new Error("The Java debug call returned no session resource");
        await call("read", { path: source });
        const file = await call("read", { path: `${source}/source`, views: ["anchors"] });
        const data = file.structuredContent as
          | {
              data?: { lines?: { lineNumber: number; anchors?: string[] }[] };
            }
          | undefined;
        const anchor = data?.data?.lines?.find((line) => line.lineNumber === 4)?.anchors?.[0];
        if (anchor === undefined) throw new Error("The Java source read returned no line-4 anchor");
        await call("insert", { path: `${source}/source`, anchor, text: "breakpoint" });
        const started = await call("insert", { path: source, text: "start" });
        const stopped = await call("read", { path: source });
        return { content: stopped.content, details: started.details };
      }
      if (source === undefined) throw new Error("Start the Java session before continuing");
      await call("insert", { path: source, text: "continue" });
      const terminated = await call("read", { path: source });
      await call("delete", { path: source });
      return { content: terminated.content, details: terminated.details };
    },
  });
}

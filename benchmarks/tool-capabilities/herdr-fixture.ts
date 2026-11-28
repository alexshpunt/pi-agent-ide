import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Deterministic Herdr bridge for capability attempts. No real agent is launched. */
export default async function fixture(pi: ExtensionAPI) {
  let cwd = "";
  let launched = false;
  pi.on("session_start", (_event, context) => {
    cwd = context.cwd;
  });
  const record = (text: string) => appendFile(path.join(cwd, "herdr-journal.txt"), `${text}\n`);
  pi.events.on("herdr:bridge", (request: unknown) => {
    const bridge = {
      version: 1,
      async command(name: string, args: Record<string, unknown>) {
        if (name === "workflow.get")
          return {
            profiles: [
              {
                id: "research",
                name: "Research",
                model: "fixture/model",
                description: "Research tasks",
              },
            ],
          };
        if (name === "agent.list")
          return {
            agents: [
              { terminal: "fixture/t7", name: "fixture-agent", state: "live", status: "done" },
              ...(launched
                ? [{ terminal: "fixture/t9", name: "fixture-child", state: "live", status: "done" }]
                : []),
            ],
          };
        if (name === "agent.inspect") {
          const terminal = String(args.terminal);
          if (terminal !== "fixture/t7" && !(terminal === "fixture/t9" && launched))
            throw Error("No such terminal");
          return {
            terminal,
            name: "fixture-agent",
            state: "live",
            pid: 1,
            session: "fixture-session",
            inspection: {
              busy: false,
              failed: false,
              omitted: { calls: 0, reasoning: 0 },
              events: [{ kind: "reply", at: "2026-11-17T00:00:00Z", text: "fixture-reply" }],
            },
          };
        }
        if (name === "agent.replicate") {
          const rows = (await readFile(String(args.session), "utf8")).trim().split("\n");
          const header = JSON.parse(rows[0] ?? "null") as { id?: unknown } | null;
          if (typeof header?.id !== "string") throw Error("Invalid copied session");
          launched = true;
          await record(`replicate:${String(args.name)}`);
          return { terminal: "fixture/t9", tab: "fixture/tb9", space: "fixture/sp1" };
        }
        if (name === "agent.subagent") {
          if (args.profile !== "research") throw Error("Unknown profile");
          launched = true;
          await record(`subagent:${String(args.name)}:${args.profile}`);
          return {
            outcome: "started",
            terminal: "fixture/t9",
            tab: "fixture/tb9",
            space: "fixture/sp1",
            model: "fixture/model",
          };
        }
        if (name === "agent.send" || name === "agent.remove") {
          const terminal = String(args.terminal);
          if (
            (terminal !== "fixture/t7" && !(terminal === "fixture/t9" && launched)) ||
            args.pid !== 1 ||
            args.session !== "fixture-session"
          )
            throw Error("PID or session changed");
          if (name === "agent.send") await record(`send:${terminal}:${String(args.message)}`);
          else {
            await record(`remove:${terminal}`);
            if (terminal === "fixture/t9") launched = false;
          }
          return { outcome: name === "agent.send" ? "submitted" : "removed" };
        }
        throw Error(`Unexpected bridge command ${name}`);
      },
    };
    (request as { provide(api: unknown): void }).provide({
      ...bridge,
      async commandTracked(name: string, args: Record<string, unknown>) {
        return {
          id: "fixture-request",
          revision: "fixture-revision",
          result: await bridge.command(name, args),
        };
      },
    });
  });
}

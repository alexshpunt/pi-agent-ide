import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { renderToon } from "./format.ts";
import { StringEnum } from "./string-enum.ts";
import type { MainContext, Renderable, Runtime } from "./types.ts";

const ACTIONS = [
  "dashboard",
  "init",
  "auth",
  "issues",
  "projects",
  "teams",
  "users",
  "comments",
  "documents",
  "milestones",
  "cycles",
  "statuses",
  "labels",
] as const;

const parameters = Type.Object({
  action: StringEnum(ACTIONS, {
    description: "Linear operation group to run; dashboard runs linear-axi with no arguments",
  }),
  args: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Arguments after the operation group, such as ['list', '--assignee', 'me', '--limit', '25']",
    }),
  ),
});

type RuntimeFactory = (context: MainContext) => Promise<Runtime>;
type Dispatcher = (args: string[], runtime: Runtime) => Promise<Renderable>;

function commandArgs(action: (typeof ACTIONS)[number], args: string[]): string[] {
  if (action === "dashboard") return [];
  if (action === "auth" && args[0] === "login" && !args.includes("--manual")) {
    return [action, ...args, "--manual"];
  }
  return [action, ...args];
}

export function registerLinearExtension(
  pi: Pick<ExtensionAPI, "registerTool">,
  // OMP's install-time validator rejects the MCP client's transitive CJS graph; load it on use.
  runtimeFactory: RuntimeFactory = async (context) =>
    (await import("./cli.ts")).makeRuntime(context),
  dispatch: Dispatcher = async (args, runtime) => (await import("./cli.ts")).run(args, runtime),
): void {
  pi.registerTool({
    name: "linear_axi",
    label: "Linear",
    description:
      "Operate Linear issues, projects, documents, comments, milestones, cycles, statuses, labels, users, teams, authentication, and repo project bindings. Returns compact TOON output.",
    promptSnippet: "Operate Linear through the agent-oriented linear-axi interface",
    promptGuidelines: [
      "Use linear_axi for Linear operations instead of raw Linear MCP calls when the tool is available.",
    ],
    parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Linear operation cancelled");

      const sessionId = ctx.sessionManager.getSessionId();
      const runtime = await runtimeFactory({
        cwd: ctx.cwd,
        env: {
          ...process.env,
          ...(sessionId ? { PI_SESSION_ID: sessionId } : {}),
        },
        stdout: { write: () => true },
      });

      const args = commandArgs(params.action, params.args ?? []);

      let value: Renderable;
      try {
        value = await dispatch(args, runtime);
      } catch (error) {
        throw new Error((await import("./cli.ts")).formatError(error).output, { cause: error });
      } finally {
        await runtime.client.close?.();
      }

      const text = typeof value === "string" ? value : renderToon(value);
      const truncation = truncateHead(text, {
        maxBytes: DEFAULT_MAX_BYTES,
        maxLines: DEFAULT_MAX_LINES,
      });

      if (!truncation.truncated) {
        return {
          content: [{ type: "text", text }],
          details: { action: params.action },
        };
      }

      const directory = await mkdtemp(join(tmpdir(), "linear-axi-"));
      const outputPath = join(directory, `${params.action}.toon`);
      await writeFile(outputPath, text, "utf8");
      const preview = truncation.firstLineExceedsLimit
        ? truncateLine(text.split("\n", 1)[0], 4000).text
        : truncation.content;
      const previewLines = preview ? preview.split("\n").length : 0;
      const previewBytes = Buffer.byteLength(preview);
      const notice =
        `\n\n[Output truncated: ${previewLines} of ${truncation.totalLines} lines ` +
        `(${formatSize(previewBytes)} of ${formatSize(truncation.totalBytes)}). ` +
        `Full output saved to: ${outputPath}]`;

      return {
        content: [{ type: "text", text: preview + notice }],
        details: { action: params.action },
      };
    },
  });
}

export default function linearExtension(pi: ExtensionAPI): void {
  registerLinearExtension(pi);
}

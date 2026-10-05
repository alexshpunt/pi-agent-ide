import type { LspClient } from "./client.js";

/** Load unopened TypeScript project files before a workspace query; other servers keep their own readiness rules. */
export async function prepareProjectQuery(client: LspClient, source: string): Promise<void> {
  if (!client.supportsCommand("typescript.tsserverRequest")) return;
  const project = await client.sendRequest<{ success?: boolean } | null>(
    "workspace/executeCommand",
    {
      command: "typescript.tsserverRequest",
      arguments: [
        "projectInfo",
        { file: source, needFileNameList: true },
        { isAsync: false, expectsResult: true },
      ],
    },
  );
  if (project?.success !== true)
    throw new Error("TypeScript could not load the project for a workspace query.");
}

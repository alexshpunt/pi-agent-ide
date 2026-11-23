import type { LspClient } from "./client.ts";

const TSSERVER_REQUEST = "typescript.tsserverRequest";

export function hasTypeScriptProjectQueries(client: LspClient): boolean {
  return client.supportsCommand(TSSERVER_REQUEST);
}

type TsserverQuery =
  | ["projectInfo", { file: string; needFileNameList: true }]
  | ["navto", { searchValue: string }];

export async function requestTsserver<Body>(
  client: LspClient,
  query: TsserverQuery,
  signal?: AbortSignal,
): Promise<Body | undefined> {
  signal?.throwIfAborted();
  const response = await client.sendRequest<{ success: boolean; body?: Body } | null>(
    "workspace/executeCommand",
    {
      command: TSSERVER_REQUEST,
      arguments: [...query, { isAsync: false, expectsResult: true }],
    },
    signal,
  );
  signal?.throwIfAborted();
  if (response?.success !== true)
    throw new Error(`TypeScript project request failed (${query[0]}).`);
  return response.body;
}

/** Load the seed's project and report the files it already covers, in server path spelling. */
export async function loadQueryProject(
  client: LspClient,
  uri: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  signal?.throwIfAborted();
  if (!hasTypeScriptProjectQueries(client)) return [];
  const project = await requestTsserver<{ fileNames?: string[] }>(
    client,
    ["projectInfo", { file: client.serverDocumentPath(uri), needFileNameList: true }],
    signal,
  );
  return project?.fileNames ?? [];
}

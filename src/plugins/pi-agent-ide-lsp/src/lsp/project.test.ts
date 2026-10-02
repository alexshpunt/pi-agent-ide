import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { LspClient } from "./client.js";
import { prepareProjectQuery } from "./project.js";

afterEach(() => vi.restoreAllMocks());

function client() {
  return new LspClient({
    serverId: "fixture",
    rootUri: pathToFileURL(process.cwd()).href,
    command: ["fixture"],
  });
}

test("loads unopened project files only through the server's advertised command", async () => {
  const provider = client();
  const supported = vi.spyOn(provider, "supportsCommand").mockReturnValue(false);
  const request = vi.spyOn(provider, "sendRequest").mockResolvedValue({ success: true });
  await prepareProjectQuery(provider, "source.ts");
  expect(request).not.toHaveBeenCalled();
  supported.mockReturnValue(true);
  await prepareProjectQuery(provider, "source.ts");
  expect(request).toHaveBeenCalledWith("workspace/executeCommand", {
    command: "typescript.tsserverRequest",
    arguments: [
      "projectInfo",
      { file: "source.ts", needFileNameList: true },
      { isAsync: false, expectsResult: true },
    ],
  });
});

test.each([null, { success: false }])(
  "rejects unsuccessful project preparation: %s",
  async (reply) => {
    const provider = client();
    vi.spyOn(provider, "supportsCommand").mockReturnValue(true);
    vi.spyOn(provider, "sendRequest").mockResolvedValue(reply);
    await expect(prepareProjectQuery(provider, "source.ts")).rejects.toThrow(
      "TypeScript could not load the project",
    );
  },
);

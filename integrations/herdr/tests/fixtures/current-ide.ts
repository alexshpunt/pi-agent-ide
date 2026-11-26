import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEARCH_API_VERSION as sdkSearchApiVersion } from "pi-agent-ide/api/search";

/** Use the installed SDK dependency for integration tests, without imposing Git checkout policy. */
export async function currentIde() {
  const sdkSearchEntry = await realpath(fileURLToPath(import.meta.resolve("pi-agent-ide/api/search")));
  let source = path.dirname(sdkSearchEntry);
  let metadata;
  for (;;) {
    try {
      const candidate = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
      if (candidate.name === "pi-agent-ide") { metadata = candidate; break; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(source);
    if (parent === source) throw new Error("Cannot find the installed IDE package root.");
    source = parent;
  }
  const extensions: unknown = metadata.pi?.extensions;
  if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== "string")
    throw new Error("The installed IDE dependency must declare its integration extension.");
  const extension = path.resolve(source, extensions[0]);
  return {
    extension,
    async record(directory: string) {
      await writeFile(path.join(directory, "ide-source.json"), JSON.stringify({
        version: metadata.version,
        source,
        extension,
        sdkSearchApiVersion,
        sdkSearchEntry,
      }, null, 2));
    },
  };
}

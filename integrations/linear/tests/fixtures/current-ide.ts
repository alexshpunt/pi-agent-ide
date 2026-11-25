import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEARCH_API_VERSION as sdkSearchApiVersion } from "pi-agent-ide/api/search";

/** Resolve the Pi extension from the same package as the imported SDK. */
export async function currentIde() {
  const sdkSearchEntry = await realpath(fileURLToPath(import.meta.resolve("pi-agent-ide/api/search")));
  let source = path.dirname(sdkSearchEntry);
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(path.join(source, "package.json"), "utf8"));
      if (manifest.name === "pi-agent-ide") {
        const extensions: unknown = manifest.pi?.extensions;
        if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== "string") {
          throw new Error("The Linear test SDK must declare one Pi extension.");
        }
        const extension = await realpath(path.resolve(source, extensions[0]));
        if (!extension.startsWith(source + path.sep)) {
          throw new Error("The Linear test SDK extension must belong to the resolved package.");
        }
        return {
          extension,
          source,
          version: manifest.version as string,
          async record(directory: string) {
            await writeFile(path.join(directory, "ide-source.json"), JSON.stringify({
              version: manifest.version,
              source,
              extension,
              sdkSearchApiVersion,
              sdkSearchEntry,
            }, null, 2));
          },
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(source);
    if (parent === source) throw new Error("Cannot resolve the Linear test IDE SDK package.");
    source = parent;
  }
}

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = path.resolve(import.meta.dirname, "../../..");
const repoRoot = path.resolve(packageRoot, "../../..");
const temporaryRoot = path.join(repoRoot, ".tmp");

export interface GeneratedReadExtensions {
  readonly paths: readonly string[];
  dispose(): Promise<void>;
}

export async function generateReadExtensions(
  pluginSources: readonly string[] = [],
): Promise<GeneratedReadExtensions> {
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(path.join(temporaryRoot, "pi-agent-read-extensions-"));
  const coreExtension = path.join(directory, "core-extension.ts");
  const paths = [coreExtension];

  await writeFile(coreExtension, extensionSource("src/extensions/pi-agent-read/index.ts"), "utf8");

  for (const [index, pluginSource] of pluginSources.entries()) {
    const pluginExtension = path.join(directory, `plugin-extension-${index + 1}.ts`);
    await writeFile(pluginExtension, extensionSource(pluginSource), "utf8");
    paths.push(pluginExtension);
  }

  return {
    paths,
    async dispose(): Promise<void> {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function extensionSource(source: string): string {
  const file = resolvePackageImport(source);
  return `export { default } from ${JSON.stringify(pathToFileURL(file).href)};\n`;
}

function resolvePackageImport(source: string): string {
  const roots = [
    { prefix: "#src/", directory: "src" },
    { prefix: "#tests/", directory: "tests" },
  ] as const;
  const root = roots.find(({ prefix }) => source.startsWith(prefix));

  if (root === undefined) {
    return path.resolve(repoRoot, source);
  }

  const relativePath = source.slice(root.prefix.length).replace(/\.js$/, ".ts");
  return path.join(packageRoot, root.directory, relativePath);
}

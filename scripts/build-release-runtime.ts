import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { build } from "esbuild";

/** A source workspace package and the copies shipped in one release tree. */
export interface RuntimePackage {
  readonly source: string;
  readonly targets: readonly string[];
}

type Manifest = Record<string, unknown>;
interface Entry {
  readonly source: string;
  readonly name: string;
}
interface Redirect {
  readonly directory: string;
  readonly entry: Entry;
}

/**
 * Compiles all public entrypoints together so tools and external plugins share state.
 * Source files remain available for TypeScript consumers and module-relative resources.
 */
export async function buildReleaseRuntime(
  repositoryRoot: string,
  targetRoot: string,
  packages: readonly RuntimePackage[],
): Promise<void> {
  const entries = new Map<string, Entry>();
  const redirects: Redirect[] = [];
  const manifests: { directory: string; manifest: Manifest }[] = [];
  const internalNames = new Set(packages.map(({ source }) => String(readManifest(source).name)));
  internalNames.add(String(readManifest(repositoryRoot).name));

  const entryFor = (source: string): Entry => {
    const absolute = path.resolve(source);
    let entry = entries.get(absolute);
    if (entry === undefined) {
      entry = {
        source: absolute,
        name:
          absolute === path.join(repositoryRoot, "src/pi-agent-ide.ts")
            ? "pi-agent-ide"
            : `entry-${entries.size}`,
      };
      entries.set(absolute, entry);
    }
    return entry;
  };

  const prepare = (source: string, directory: string): void => {
    const manifest = readManifest(directory);
    const redirect = (target: string): string => {
      const entry = entryFor(path.resolve(source, target));
      if (directory === targetRoot) return `./dist/${entry.name}.js`;
      redirects.push({ directory, entry });
      return `./runtime/${entry.name}.js`;
    };
    const exports = manifest.exports as Record<string, unknown> | undefined;
    if (exports !== undefined) {
      manifest.exports = Object.fromEntries(
        Object.entries(exports).map(([name, value]) => {
          if (typeof value === "string") {
            return [name, { types: value, default: redirect(value) }];
          }
          const conditions = value as Record<string, string>;
          if (typeof conditions.default !== "string") {
            throw new Error(`Missing default export for ${String(manifest.name)}:${name}`);
          }
          return [name, { ...conditions, default: redirect(conditions.default) }];
        }),
      );
    }
    const pi = manifest.pi as { extensions?: string[] } | undefined;
    if (pi?.extensions !== undefined) {
      manifest.pi = { ...pi, extensions: pi.extensions.map(redirect) };
    }
    if (directory === targetRoot) {
      manifest.files = [...new Set([...(manifest.files as string[]), "dist"])];
    }
    manifests.push({ directory, manifest });
  };

  prepare(repositoryRoot, targetRoot);
  for (const owner of packages) {
    for (const directory of owner.targets) {
      if (existsSync(path.join(directory, "package.json"))) prepare(owner.source, directory);
    }
  }

  const outputDirectory = path.join(targetRoot, "dist");
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: Object.fromEntries(
      [...entries.values()].map((entry) => [entry.name, entry.source]),
    ),
    outdir: outputDirectory,
    chunkNames: "chunk-[hash]",
    bundle: true,
    splitting: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    keepNames: true,
    metafile: true,
    plugins: [
      {
        name: "release-runtime",
        setup(builder) {
          builder.onResolve({ filter: /^[^./#]/ }, ({ path: specifier }) => {
            const name = specifier.startsWith("@")
              ? specifier.split("/").slice(0, 2).join("/")
              : specifier.split("/")[0];
            return internalNames.has(name ?? "") ? undefined : { path: specifier, external: true };
          });
          builder.onLoad({ filter: /\.ts$/ }, ({ path: source }) => {
            const contents = readFileSync(source, "utf8");
            if (!contents.includes("import.meta.url")) return undefined;
            // Every output lives directly in dist. Keep module-relative config and
            // createRequire anchored to the shipped source, not an arbitrary chunk.
            const shippedSource = path.join(targetRoot, path.relative(repositoryRoot, source));
            const relative = path
              .relative(outputDirectory, shippedSource)
              .split(path.sep)
              .join("/");
            return {
              contents: contents.replaceAll(
                "import.meta.url",
                `new URL(${JSON.stringify(relative)}, import.meta.url).href`,
              ),
              loader: "ts",
            };
          });
        },
      },
    ],
  });

  for (const { directory, entry } of redirects) {
    const wrapper = path.join(directory, "runtime", `${entry.name}.js`);
    const output = path.join(outputDirectory, `${entry.name}.js`);
    const specifier = path.relative(path.dirname(wrapper), output).split(path.sep).join("/");
    const metadata =
      result.metafile.outputs[path.relative(repositoryRoot, output).split(path.sep).join("/")];
    if (metadata === undefined) throw new Error(`Missing compiled entry ${entry.name}`);
    const source = JSON.stringify(specifier.startsWith(".") ? specifier : `./${specifier}`);
    mkdirSync(path.dirname(wrapper), { recursive: true });
    writeFileSync(
      wrapper,
      `export * from ${source};\n${metadata.exports.includes("default") ? `export { default } from ${source};\n` : ""}`,
    );
  }
  for (const { directory, manifest } of manifests) {
    writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function readManifest(directory: string): Manifest {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as Manifest;
}

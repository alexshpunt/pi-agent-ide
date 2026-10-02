import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";

// Bundle the same lifecycle checks for an isolated installed-package test on either host.
const directory = path.resolve(process.argv[2] ?? ".tmp/java-checks");
await mkdir(directory, { recursive: true });
for (const [entry, filename] of [
  ["tests/integration/debugger-java-native.integration.test.ts", "java-native.test.mjs"],
  ["tests/integration/debugger-java-public.integration.test.ts", "java-public.test.mjs"],
  ["tests/integration/support/java-public-fixture.ts", "java-public-fixture.mjs"],
] as const) {
  await build({
    entryPoints: [entry],
    outfile: path.join(directory, filename),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: [
      "vitest",
      "pi-coding-agent-test",
      "pi-coding-agent-test/*",
      "@earendil-works/*",
      "typebox",
    ],
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
}

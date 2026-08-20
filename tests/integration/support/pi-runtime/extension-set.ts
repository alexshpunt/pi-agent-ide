import path from "node:path";

const repoRoot = process.cwd();
const extensionPaths = [
  "src/extensions/pi-agent-read/index.ts",
  "src/extensions/pi-agent-search/index.ts",
  "src/extensions/pi-agent-search/plugins/pi-agent-search-text/index.ts",
  "tests/integration/extensions/pi-agent-text-editor/register-extension.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/plugins/pi-agent-filesystem-text/index.ts",
  "src/extensions/pi-agent-read/extensions/pi-agent-filesystem/index.ts",
  "src/plugins/pi-agent-ide-ast/index.ts",
].map((source) => path.join(repoRoot, source));

export interface IntegrationExtensionSet {
  readonly paths: readonly string[];
  dispose(): Promise<void>;
}

export function createExtensionSet(): IntegrationExtensionSet {
  return {
    paths: extensionPaths,
    dispose: () => Promise.resolve(),
  };
}

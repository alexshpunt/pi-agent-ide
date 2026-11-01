import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readAgentIdeSetting } from "#src/api/settings.js";
import {
  inspectProject,
  indexProject,
  searchProject,
} from "#src/plugins/pi-agent-ide-semantic/src/backend.js";
import {
  inspectVeraProject,
  indexVeraProject,
  searchVeraProject,
} from "#src/plugins/pi-agent-ide-semantic/src/vera-backend.js";
import { createConfiguredSemanticExtension, type SemanticBackend } from "./extension.js";

const colgrep: SemanticBackend = {
  async available(cwd) {
    return (await inspectProject(cwd)).usable;
  },
  async index(cwd, signal, onProgress) {
    await indexProject(cwd, {
      signal,
      onProgress(message) {
        if (
          message.startsWith("Downloading ColGREP") ||
          message.startsWith("Indexing project with ColGREP")
        )
          onProgress?.(message);
      },
    });
  },
  async search(cwd, query, options, signal) {
    return searchProject(cwd, query, { ...options, signal });
  },
};

const vera: SemanticBackend = {
  async available(cwd) {
    return (await inspectVeraProject(cwd)).usable;
  },
  async index(cwd, signal, onProgress) {
    await indexVeraProject(cwd, {
      signal,
      onProgress(message) {
        if (
          message.startsWith("Downloading Vera") ||
          message.startsWith("Preparing Vera local model") ||
          message.startsWith("Indexing project with Vera")
        )
          onProgress?.(message);
      },
    });
  },
  async search(cwd, query, options, signal) {
    return searchVeraProject(cwd, query, { ...options, signal });
  },
};

export default async function registerSemanticSearch(pi: ExtensionAPI): Promise<void> {
  const extension = createConfiguredSemanticExtension({ colgrep, vera }, async (cwd) => {
    const value = (await readAgentIdeSetting(pi.events, "search.semantic.engine", cwd)).value;
    if (typeof value !== "string") throw new Error("Invalid semantic search engine setting");
    return value;
  });
  await extension(pi);
}

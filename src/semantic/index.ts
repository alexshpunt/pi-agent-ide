import {
  inspectProject,
  indexProject,
  searchProject,
} from "#src/plugins/pi-agent-ide-semantic/src/backend.js";
import { createSemanticExtension } from "./extension.js";

export default createSemanticExtension({
  async available(cwd) {
    return (await inspectProject(cwd)).usable;
  },
  async index(cwd, signal, onProgress) {
    await indexProject(cwd, { signal, onProgress });
  },
  async search(cwd, query, options, signal) {
    return searchProject(cwd, query, { ...options, signal });
  },
});

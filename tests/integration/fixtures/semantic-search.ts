import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSemanticExtension } from "#src/semantic/extension.ts";

export default createSemanticExtension({
  async available(cwd) { return existsSync(join(cwd, ".semantic-test-index")); },
  async index() { throw new Error("Not supported by this fixture"); },
  async search() { return { text: "example.ts:1-2", files: ["example.ts"] }; },
});

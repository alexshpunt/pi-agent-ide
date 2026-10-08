import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ResourceError } from "pi-agent-resource";
import { expect, test } from "vitest";
import { TEXT_EDITOR_API_VERSION, TEXT_EDITOR_PROTOCOL } from "#src/api/plugin-protocol.js";
import { createTextEditorCore } from "#src/core/text-editor-core.js";
import { executeScriptMutation, executeTextMutation } from "#src/core/text-mutation.js";
import { writeMutationTool } from "#src/tools/tool-text-write.js";

for (const { declaredSafe, effect } of [
  { declaredSafe: false, effect: "not-applied" },
  { declaredSafe: true, effect: "not-applied" },
  { declaredSafe: true, effect: "unknown" },
] as const) {
  test(`edits expose provider failure codes only when declared safe (${declaredSafe}, ${effect})`, async () => {
    const source = "fixture://owner/note%20caf%C3%A9.txt";
    const error = declaredSafe
      ? new ResourceError("TRANSPORT_FAILED", source, effect)
      : Object.assign(new Error("Private transport diagnostic"), {
          code: "TRANSPORT_FAILED",
          source,
          effect: "not-applied",
        });
    error.message = "Private transport diagnostic";
    const core = createTextEditorCore();
    await core.registerPlugin({
      id: "fixture",
      protocol: TEXT_EDITOR_PROTOCOL,
      apiVersion: TEXT_EDITOR_API_VERSION,
      setup(api) {
        api.addResolver({
          resolver: {
            id: "fixture",
            async tryResolve() {
              throw error;
            },
          },
        });
      },
    });
    const context = { cwd: process.cwd() } as ExtensionContext;
    const args = { path: source, content: "Must not write\n" };
    const code = declaredSafe ? "TRANSPORT_FAILED" : "RESOLVE_FAILED";
    const ordinary = await executeTextMutation(core, writeMutationTool, args, undefined, context);
    expect(ordinary.details.results?.[0]?.data.errors?.[0]?.code).toBe(code);
    expect(ordinary.details.effect).toBe(effect);
    expect(JSON.stringify(ordinary)).not.toContain("Private transport diagnostic");
    const script = await executeScriptMutation(core, writeMutationTool, args, undefined, context);
    expect(script).toMatchObject({ ok: false, effect, errors: [{ source, code }] });
    expect(JSON.stringify(script)).not.toContain("Private transport diagnostic");
    if (effect === "unknown") {
      expect(script.errors[0]?.message).toContain("inspect the resource before retrying");
      expect(JSON.stringify(ordinary)).toContain("inspect the resource before retrying");
    }
  });
}

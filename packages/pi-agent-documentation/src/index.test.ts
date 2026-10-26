import { expect, test } from "vitest";
import { createPackagedAgentGuideLoader } from "./index.js";

function guides(files: Map<string, string>) {
  return createPackagedAgentGuideLoader(async (id) => {
    const markdown = files.get(id);
    if (markdown === undefined) throw new Error(`ENOENT: ${id}.md`);
    return markdown;
  });
}

test("a reused extension factory keeps guides it read after the package files change", async () => {
  // Pi reuses the loaded factory when it switches sessions; the checkout may have changed since.
  const files = new Map([["kept", "first"]]);
  const load = guides(files);
  const definition = { id: "kept", description: "Kept guide", triggers: [] };
  expect((await load(definition)).markdown).toBe("first");
  files.delete("kept");
  expect((await load(definition)).markdown).toBe("first");
});

test("a failed guide read is retried by the next registration", async () => {
  const files = new Map<string, string>();
  const load = guides(files);
  const definition = { id: "late", description: "Late guide", triggers: [] };
  await expect(load(definition)).rejects.toThrow("ENOENT");
  files.set("late", "now");
  expect((await load(definition)).markdown).toBe("now");
});

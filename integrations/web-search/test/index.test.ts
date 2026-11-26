import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import registerWebSearch from "#web-search-entry";

it("registers web search tools and the doctor command with Pi", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "web-search-registration-"));
  try {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [registerWebSearch],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    expect(loaded.errors).toEqual([]);
    const extension = loaded.extensions.find((item) => item.tools.has("web_search"));
    assert.ok(extension);
    expect([...extension.tools.keys()]).toEqual([
      "web_search",
      "image_search",
      "wait_for_web_searches",
    ]);
    expect([...extension.commands.keys()]).toEqual(["pi-web-search-doctor"]);
    const tool = extension.tools.get("web_search")?.definition;
    assert.ok(tool);
    const parameters = tool.parameters as {
      required?: string[];
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(parameters.required).toEqual(["query"]);
    expect(Object.keys(parameters.properties ?? {})).toEqual(["query", "limit", "background"]);
    expect(parameters.properties?.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 20,
    });
    expect(parameters.additionalProperties).toBe(false);
    expect(typeof tool.description).toBe("string");
    expect(tool.promptGuidelines?.length).toBeGreaterThan(0);
    expect(tool.prepareArguments).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

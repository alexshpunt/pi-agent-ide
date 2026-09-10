import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { readExtensionSettingsScope } from "./extensions-config.js";

/** A scope override; default removes this scope's explicit choice. */
export type ModuleChoice = "default" | "enabled" | "disabled";

/** Save only changed module overrides, preserving other settings and unknown IDs. */
export async function saveModuleChoices(
  configPath: string,
  choices: ReadonlyMap<string, ModuleChoice>,
  featureChoices: ReadonlyMap<string, boolean | undefined> = new Map(),
): Promise<void> {
  await withFileMutationQueue(configPath, async () => {
    const settings = await readExtensionSettingsScope(configPath);
    let original: Record<string, unknown> = {};
    try {
      original = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const disabled = new Set(settings.disabled);
    const enabled = new Set(settings.enabled);
    for (const [id, choice] of choices) {
      disabled.delete(id);
      enabled.delete(id);
      if (choice === "disabled") disabled.add(id);
      if (choice === "enabled") enabled.add(id);
    }
    const flags = { ...settings.flags };
    for (const [id, value] of featureChoices) {
      if (id === "pi-agent-ide-no-animations") delete original.noAnimations;
      if (id === "pi-agent-ide-no-post-processing") delete original.noPostProcessing;
      if (value === undefined) delete flags[id];
      else flags[id] = value;
    }
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify({ ...original, disabled: [...disabled], enabled: [...enabled], ...(featureChoices.size > 0 ? { flags } : {}) }, null, 2)}\n`,
    );
  });
}

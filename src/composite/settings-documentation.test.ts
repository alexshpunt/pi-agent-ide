import { expect, test } from "vitest";
import { AgentDocumentationRegistry } from "#src/documentation/registry.js";
import { BUILTIN_EXTENSIONS } from "./builtin-extensions.js";
import type { FeatureFlag } from "./feature-flags.js";
import { AGENT_IDE_PREFERENCES } from "./preferences.js";
import { AGENT_IDE_PRESET_OPTIONS } from "./presets.js";
import { createIdeSettingsDocumentation } from "./settings-documentation.js";

const flags: readonly FeatureFlag[] = [
  { id: "fixture-flag", name: "Fixture", description: "A registered boolean.", default: false },
];

function catalog(markdown: string) {
  const json = markdown.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (json === undefined) throw new Error("Missing settings catalog");
  return JSON.parse(json) as {
    preferences: unknown[];
    flags: unknown[];
    modules: { id: string; default: boolean; dependencies: readonly string[] }[];
    presets: unknown[];
  };
}

test("publishes the same preference and flag descriptors used by settings", () => {
  const guide = createIdeSettingsDocumentation(flags);
  const values = catalog(guide.markdown);
  expect(values.preferences).toEqual(AGENT_IDE_PREFERENCES);
  expect(values.flags).toEqual(flags);
  expect(values.presets).toEqual(AGENT_IDE_PRESET_OPTIONS);
  expect(values.modules).toEqual(
    BUILTIN_EXTENSIONS.map(({ id, name, description, defaultEnabled, dependencies }) => ({
      id,
      name,
      description,
      default: defaultEnabled !== false,
      dependencies,
    })),
  );
});

test("uses supplied flag registrations rather than a second hard-coded list", () => {
  const added = { id: "another-flag", name: "Another", description: "New flag.", default: true };
  const values = catalog(createIdeSettingsDocumentation([...flags, added]).markdown);
  expect(values.flags).toEqual([...flags, added]);
});

test("registers the catalog for explicit docs reads without attaching it to ordinary calls", () => {
  const registry = new AgentDocumentationRegistry();
  const guide = createIdeSettingsDocumentation(flags);
  registry.register([guide]);
  expect(registry.get("ide-settings")).toEqual(guide);
  expect(registry.matching("read", { path: "note.txt" })).toEqual([]);
  expect(registry.matching("write", { path: "extensions.json" })).toEqual([]);
});

test("publishes externally supplied preference descriptors without changing built-ins", () => {
  const external = {
    kind: "text" as const,
    id: "fixture.path",
    name: "Fixture path",
    description: "External configuration value.",
    default: "",
    group: "features" as const,
  };
  const values = catalog(
    createIdeSettingsDocumentation(flags, [...AGENT_IDE_PREFERENCES, external]).markdown,
  );
  expect(values.preferences).toEqual([...AGENT_IDE_PREFERENCES, external]);
});

test("a registered settings catalog reflects late external registrations", () => {
  const registry = new AgentDocumentationRegistry();
  const mutableFlags = [...flags];
  registry.register([createIdeSettingsDocumentation(mutableFlags)]);
  mutableFlags.push({ id: "late", name: "Late", description: "Registered later.", default: false });
  const guide = registry.get("ide-settings");
  if (!guide) throw new Error("Settings guide missing");
  expect(catalog(guide.markdown).flags).toEqual(mutableFlags);
});

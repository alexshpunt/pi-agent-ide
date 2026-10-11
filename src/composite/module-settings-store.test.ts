import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, onTestFinished } from "vitest";
import { saveModuleChoices } from "./module-settings-store.js";
import { readPiAgentIdeExtensionsConfig } from "./extensions-config.js";

test("Codemode project preference overrides global and Default restores inheritance", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-codemode-scopes-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const paths = {
    globalPath: path.join(cwd, "global/extensions.json"),
    projectPath: path.join(cwd, "project/extensions.json"),
  };
  await saveModuleChoices(
    paths.globalPath,
    new Map(),
    new Map(),
    new Map([
      ["ui.codemode", "on"],
      ["future", "global keep"],
    ]),
  );
  await saveModuleChoices(
    paths.projectPath,
    new Map(),
    new Map(),
    new Map([
      ["ui.codemode", "off"],
      ["ui.read", "disabled"],
    ]),
  );
  expect((await readPiAgentIdeExtensionsConfig(paths)).preferences).toEqual({
    "ui.codemode": "off",
    future: "global keep",
    "ui.read": "disabled",
  });
  await saveModuleChoices(
    paths.projectPath,
    new Map(),
    new Map(),
    new Map([["ui.codemode", undefined]]),
  );
  expect((await readPiAgentIdeExtensionsConfig(paths)).preferences).toEqual({
    "ui.codemode": "on",
    future: "global keep",
    "ui.read": "disabled",
  });
  expect(JSON.parse(await readFile(paths.projectPath, "utf8"))).toMatchObject({
    preferences: { "ui.read": "disabled" },
  });
  expect(JSON.parse(await readFile(paths.globalPath, "utf8"))).toMatchObject({
    preferences: { "ui.codemode": "on", future: "global keep" },
  });
});

test("saves overrides without losing unrelated settings or obsolete IDs", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-settings-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "extensions.json");
  await writeFile(
    file,
    JSON.stringify({
      disabled: ["obsolete", "lsp"],
      enabled: ["format"],
      noAnimations: true,
      custom: { keep: 1 },
    }),
  );
  await saveModuleChoices(
    file,
    new Map([
      ["lsp", "enabled"],
      ["format", "default"],
    ]),
  );
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    disabled: ["obsolete"],
    enabled: ["lsp"],
    noAnimations: true,
    custom: { keep: 1 },
  });
});

test("creates a missing scope and rejects malformed existing settings without overwriting", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-settings-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "nested", "extensions.json");
  await saveModuleChoices(file, new Map([["lsp", "disabled"]]));
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ disabled: ["lsp"] });
  await writeFile(file, "not json");
  await expect(saveModuleChoices(file, new Map([["lsp", "enabled"]]))).rejects.toBeInstanceOf(
    Error,
  );
  expect(await readFile(file, "utf8")).toBe("not json");
});

test("feature overrides preserve unrelated flags and default removes the old switch too", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-flags-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "extensions.json");
  await writeFile(file, JSON.stringify({ noAnimations: true, flags: { future: true } }));
  await saveModuleChoices(file, new Map(), new Map([["pi-agent-ide-no-animations", false]]));
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    disabled: [],
    enabled: [],
    flags: { future: true, "pi-agent-ide-no-animations": false },
  });
  await saveModuleChoices(file, new Map(), new Map([["pi-agent-ide-no-animations", undefined]]));
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    disabled: [],
    enabled: [],
    flags: { future: true },
  });
});

test("saves preset without losing unrelated settings", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-preset-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "extensions.json");
  await writeFile(file, JSON.stringify({ disabled: ["ide.vision"], custom: { keep: 1 } }));

  await saveModuleChoices(file, new Map(), new Map(), new Map(), "text-editor");

  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
    disabled: ["ide.vision"],
    enabled: [],
    preset: "text-editor",
    custom: { keep: 1 },
  });
});
test("saves string preferences and preserves unrelated values", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "ide-preferences-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, "extensions.json");
  await writeFile(file, JSON.stringify({ preferences: { future: "keep" } }));

  await saveModuleChoices(file, new Map(), new Map(), new Map([["processes.activity", "compact"]]));

  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    preferences: { future: "keep", "processes.activity": "compact" },
  });
});

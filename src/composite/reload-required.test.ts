import { describe, expect, test } from "vitest";
import { pendingReloadChanges } from "./reload-required.js";
import type { PiAgentIdeExtensionsConfig } from "./extensions-config.js";
import type { BuiltinExtension } from "./selection.js";

const modules: BuiltinExtension[] = [
  { id: "core", name: "Core", dependencies: [], register() {} },
  { id: "child", name: "Child", dependencies: ["core"], register() {} },
];
const base: PiAgentIdeExtensionsConfig = { disabled: [], enabled: [] };
const flags = [
  { id: "startup", name: "Startup", description: "x", default: false },
  { id: "pi-agent-ide-yolo", name: "YOLO", description: "x", default: false },
];
const preferences = [
  { id: "search.semantic.engine", name: "Engine", description: "x", kind: "choice" as const, group: "features" as const, default: "colgrep", values: [{ value: "colgrep", label: "C" }, { value: "vera", label: "V" }] },
  { id: "external.mode", name: "External", description: "x", kind: "text" as const, group: "ui" as const, default: "a" },
];
const pending = (current: PiAgentIdeExtensionsConfig, cliFlags: ReadonlySet<string> = new Set()) =>
  pendingReloadChanges(base, current, modules, flags, preferences, cliFlags);

describe("reload tracking", () => {
  test("reports effective module changes including dependents and clears on reversion", () => {
    expect(pending({ ...base, disabled: ["core"] })).toEqual(["Core", "Child"]);
    expect(pending(base)).toEqual([]);
  });
  test("ignores live changes and startup changes masked by the command line", () => {
    expect(pending({ ...base, flags: { "pi-agent-ide-yolo": true }, preferences: { "search.semantic.engine": "vera" } })).toEqual([]);
    expect(pending({ ...base, flags: { startup: true } }, new Set(["startup"]))).toEqual([]);
  });
  test("reports startup flags and unknown external settings without claiming they applied", () => {
    expect(pending({ ...base, flags: { startup: true }, preferences: { "external.mode": "b" } })).toEqual(["Startup", "External"]);
  });
});

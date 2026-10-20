import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  registerAgentIdeSettings,
  readAgentIdeSetting,
  type AgentIdeSetting,
} from "#src/api/settings.js";
import { createAgentIdeSettingsRegistry } from "#src/composite/settings-registry.js";

const definitions: readonly AgentIdeSetting[] = [
  {
    kind: "boolean",
    id: "external.enabled",
    name: "Enabled",
    description: "Fixture toggle",
    default: false,
  },
  {
    kind: "choice",
    id: "external.mode",
    name: "Mode",
    description: "Fixture choice",
    default: "quiet",
    values: [
      { value: "quiet", label: "Quiet" },
      { value: "loud", label: "Loud" },
    ],
  },
  { kind: "text", id: "external.path", name: "Path", description: "Fixture text", default: "" },
];

function host() {
  const emitter = new EventEmitter();
  const events: ExtensionAPI["events"] = {
    emit(name, data) {
      emitter.emit(name, data);
    },
    on(name, listener) {
      emitter.on(name, listener);
      return () => {
        emitter.off(name, listener);
      };
    },
  };
  const pi: Pick<ExtensionAPI, "events" | "on"> = { events, on: vi.fn() };
  onTestFinished(() => {
    emitter.removeAllListeners();
  });
  return { pi, events };
}

async function configuration() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "external-settings-"));
  const agent = path.join(cwd, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });
  const global = path.join(agent, "pi-agent-ide", "extensions.json");
  const project = path.join(cwd, ".pi", "pi-agent-ide", "extensions.json");
  await mkdir(path.dirname(global), { recursive: true });
  await mkdir(path.dirname(project), { recursive: true });
  return { cwd, global, project };
}

test.each(["before", "after"])("external registration works %s the IDE", async (order) => {
  const { pi, events } = host();
  const { cwd } = await configuration();
  if (order === "before") registerAgentIdeSettings(pi, "fixture", definitions);
  const registry = createAgentIdeSettingsRegistry(pi, [], []);
  if (order === "after") registerAgentIdeSettings(pi, "fixture", definitions);
  expect(registry.flags.map((item) => item.id)).toEqual(["external.enabled"]);
  expect(registry.preferences.map((item) => item.id)).toEqual(["external.mode", "external.path"]);
  expect(await readAgentIdeSetting(events, "external.enabled", cwd)).toEqual({
    value: false,
    overridden: false,
  });
  expect(await readAgentIdeSetting(events, "external.mode", cwd)).toEqual({
    value: "quiet",
    overridden: false,
  });
  expect(await readAgentIdeSetting(events, "external.path", cwd)).toEqual({
    value: "",
    overridden: false,
  });
});

test("effective reads preserve explicit false and follow Project then Global inheritance", async () => {
  const { pi, events } = host();
  const { cwd, global, project } = await configuration();
  createAgentIdeSettingsRegistry(pi, [], []);
  registerAgentIdeSettings(pi, "fixture", definitions);
  await writeFile(
    global,
    JSON.stringify({
      flags: { "external.enabled": true },
      preferences: { "external.mode": "loud" },
    }),
  );
  await writeFile(project, JSON.stringify({ flags: { "external.enabled": false } }));
  expect(await readAgentIdeSetting(events, "external.enabled", cwd)).toEqual({
    value: false,
    overridden: true,
  });
  expect(await readAgentIdeSetting(events, "external.mode", cwd)).toEqual({
    value: "loud",
    overridden: true,
  });
  await writeFile(project, "{}");
  expect(await readAgentIdeSetting(events, "external.enabled", cwd)).toEqual({
    value: true,
    overridden: true,
  });
  await writeFile(global, "{}");
  expect(await readAgentIdeSetting(events, "external.enabled", cwd)).toEqual({
    value: false,
    overridden: false,
  });
});

test("invalid registration cannot partially claim IDs or replace another owner", () => {
  const { pi } = host();
  const registry = createAgentIdeSettingsRegistry(pi, [], []);
  registerAgentIdeSettings(pi, "fixture", definitions);
  expect(() =>
    registerAgentIdeSettings(pi, "intruder", [
      {
        kind: "boolean",
        id: "external.enabled",
        name: "Enabled",
        description: "Fixture toggle",
        default: true,
      },
    ]),
  ).toThrow(/already registered/u);
  expect(() =>
    registerAgentIdeSettings(pi, "bad", [
      {
        kind: "boolean",
        id: "valid.unclaimed",
        name: "Valid",
        description: "Fixture",
        default: false,
      },
      {
        kind: "choice",
        id: "invalid.choice",
        name: "Invalid",
        description: "No matching default",
        default: "missing",
        values: [{ value: "present", label: "Present" }],
      },
    ]),
  ).toThrow(/choice default/u);
  expect(registry.flags.map((item) => item.id)).toEqual(["external.enabled"]);
});

test("unknown settings and unavailable services fail explicitly", async () => {
  const { pi, events } = host();
  const { cwd } = await configuration();
  await expect(readAgentIdeSetting(events, "absent", cwd)).rejects.toThrow(/unavailable/u);
  createAgentIdeSettingsRegistry(pi, [], []);
  await expect(readAgentIdeSetting(events, "absent", cwd)).rejects.toThrow(/Unknown/u);
});

test("malformed configuration and unsupported choice overrides are not defaults", async () => {
  const { pi, events } = host();
  const { cwd, global } = await configuration();
  createAgentIdeSettingsRegistry(pi, [], []);
  registerAgentIdeSettings(pi, "fixture", definitions);
  await writeFile(global, JSON.stringify({ preferences: { "external.mode": "unsupported" } }));
  await expect(readAgentIdeSetting(events, "external.mode", cwd)).rejects.toThrow(
    /saved setting choice/u,
  );
  await writeFile(global, "{");
  await expect(readAgentIdeSetting(events, "external.enabled", cwd)).rejects.toThrow(/JSON/u);
});

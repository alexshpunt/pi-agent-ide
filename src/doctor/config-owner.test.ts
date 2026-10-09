import { expect, test, vi } from "vitest";
import type { DoctorWorkspace } from "#src/api/doctor.js";
import { writeSuggestedConfigs } from "./config-writer.js";
import type { RecipeCandidate } from "./discovery.js";

const project = "ssh://fixture/project";
const candidate: RecipeCandidate = {
  pluginId: "formatter",
  score: 10,
  evidence: [],
  recipe: {
    id: "owned",
    name: "Owned",
    kind: "formatter",
    languages: ["typescript"],
    executables: ["owned"],
    documentation: "https://example.com/owned",
    formatter: { extensions: [".ts"], run: { command: ["owned", "{file}"] }, output: "stdout" },
  },
};

test("Doctor apply merges target configuration using the same original snapshot, without controller writes", async () => {
  const file = `${project}/.pi/pi-agent-ide/formatters.json`;
  const previous = JSON.stringify({
    version: 1,
    formatters: {
      existing: { output: "stdout", extensions: [".ts"], run: { command: ["existing", "{file}"] } },
    },
  });
  const readText = vi
    .fn()
    .mockResolvedValueOnce(previous)
    .mockRejectedValue(new Error("Unexpected reread before guarded publication"));
  const writeText = vi.fn<DoctorWorkspace["writeText"]>(async () => {});
  const workspace: Pick<DoctorWorkspace, "source" | "configPaths" | "readText" | "writeText"> = {
    source: project,
    configPaths: async () => ({ project: file, global: "ssh://fixture/home/global.json" }),
    readText,
    writeText,
  };
  await expect(writeSuggestedConfigs(project, [candidate], workspace)).resolves.toEqual([file]);
  expect(readText).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenCalledWith(file, expect.any(String), previous, undefined);
  const call = writeText.mock.calls[0];
  expect(call).toBeDefined();
  const text: unknown = call?.[1];
  if (typeof text !== "string") throw new Error("Missing target config publication");
  const config: unknown = JSON.parse(text);
  expect(config).toMatchObject({
    version: 1,
    formatters: {
      existing: { run: { command: ["existing", "{file}"] } },
      owned: candidate.recipe.formatter,
    },
  });
});

test("Doctor apply rejects a URI without its owner and retains a target publication refusal", async () => {
  await expect(writeSuggestedConfigs(project, [candidate])).rejects.toMatchObject({
    code: "UNSUPPORTED_SOURCE",
  });
  const refusal = Object.assign(new Error("Target config changed"), { code: "CONFLICT" });
  const workspace: Pick<DoctorWorkspace, "source" | "configPaths" | "readText" | "writeText"> = {
    source: project,
    configPaths: async () => ({
      project: `${project}/.pi/pi-agent-ide/formatters.json`,
      global: "ssh://fixture/home/global.json",
    }),
    readText: async () => undefined,
    writeText: async () => {
      throw refusal;
    },
  };
  await expect(writeSuggestedConfigs(project, [candidate], workspace)).rejects.toBe(refusal);
});

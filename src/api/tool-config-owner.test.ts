import { expect, test } from "vitest";
import {
  loadLayeredToolConfig,
  parseFormattersConfig,
  runConfiguredProcess,
} from "./tool-config.js";

const configuration = (command: string) =>
  JSON.stringify({
    version: 1,
    formatters: { owned: { extensions: [".ts"], run: { command: [command] }, output: "stdout" } },
  });

test("owned project and global layers replace by ID without reading URI paths locally", async () => {
  const reads: string[] = [];
  const root = "ssh://alpha/srv/project";
  const project = `${root}/.pi/pi-agent-ide/formatters.json`;
  const global = "ssh://alpha/home/agent/.pi/agent/extensions/pi-agent-ide/formatters.json";
  const result = await loadLayeredToolConfig(
    root,
    "formatters",
    (value) => parseFormattersConfig(value).formatters,
    {
      layerAccess: {
        async paths() {
          return { project, global };
        },
        async readText(source: string) {
          reads.push(source);
          return configuration(source === project ? "project-tool" : "global-tool");
        },
      },
    },
  );
  expect(reads).toEqual([project, global]);
  expect(result.entries.find((entry) => entry.id === "owned")).toMatchObject({
    layer: "project",
    sourcePath: project,
    config: { run: { command: ["project-tool"] } },
  });
  expect(result.paths.global).toBe(global);
});

test("configured commands refuse unowned URI workspaces before controller execution", async () => {
  await expect(
    runConfiguredProcess(
      { command: ["definitely-missing-owner-tool"] },
      { projectRoot: "ssh://unknown/srv/project", filePath: "ssh://unknown/srv/project/note.ts" },
    ),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
});
test("unowned SSH configuration refuses instead of consulting controller files", async () => {
  await expect(
    loadLayeredToolConfig(
      "ssh://unknown/srv/project",
      "formatters",
      (value) => parseFormattersConfig(value).formatters,
    ),
  ).rejects.toMatchObject({ code: "UNSUPPORTED_SOURCE" });
});

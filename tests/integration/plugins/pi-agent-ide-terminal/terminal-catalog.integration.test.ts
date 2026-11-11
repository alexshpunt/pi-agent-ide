import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolResultMessage,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";

import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";

const call = (id: string, name: string, arguments_: Record<string, unknown>) =>
  assistantMessage([toolCall({ id, name, arguments: arguments_ })], { stopReason: "toolUse" });

test.runIf(process.platform !== "win32")(
  "finds, searches and renames named terminal sessions through the IDE",
  async () => {
    await withTempWorkspace(async (cwd) => {
      const run = await new PiIntegrationTest({
        testName: "terminal-catalog",
        artifactsDir: testArtifactsDir(import.meta.filename),
        cwd,
        isolateUserResources: true,
        extensions: [
          "src/extensions/pi-agent-read/index.ts",
          "src/extensions/pi-agent-search/index.ts",
          "src/extensions/pi-agent-text-editor/index.ts",
          "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-constant/index.ts",
          "src/extensions/pi-agent-text-editor/plugins/pi-agent-text-anchor-exact/index.ts",
          "tests/integration/fixtures/terminal-catalog.ts",
        ].map((extension) => path.resolve(extension)),
        tools: ["bash", "read", "search", "move", "delete"],
        conversation: [
          call("start-named", "bash", {
            name: "dev-server",
            command: "printf 'catalog-needle-first\\n'; sleep 30",
            background: true,
          }),
          call("start-taken", "bash", {
            name: "dev-server",
            command: "printf 'catalog-needle-second\\n'",
          }),
          call("list", "read", { path: "shell:" }),
          call("search-all", "search", { path: "shell:", query: "catalog-needle" }),
          call("rename", "move", { path: "shell:dev-server", target: "shell:web" }),
          call("read-renamed", "read", { path: "shell:web" }),
          call("read-old", "read", { path: "shell:dev-server" }),
          call("rename-invalid", "move", { path: "shell:web", target: "shell:not a name" }),
          call("delete-renamed", "delete", { path: "shell:web" }),
          assistantMessage([text("Catalog checked.")]),
        ],
      }).run("Start named terminals, list and search them, then rename one");

      const named = getToolResultMessage<{ source: string; name?: string }>(run, "start-named");
      expect(named.details).toMatchObject({ source: "shell:dev-server", name: "dev-server" });

      const taken = getToolResultMessage<{
        source: string;
        name?: string;
        nameRejection?: { name: string };
      }>(run, "start-taken");
      expect(getToolExecution(run, "start-taken").isError).toBe(false);
      expect(taken.details.name).toBeUndefined();
      expect(taken.details.source).toMatch(/^shell:[a-f0-9]{12}$/u);
      expect(taken.details.nameRejection?.name).toBe("dev-server");

      const list = getToolResultText(run, "list");
      expect(list).toContain("shell:dev-server");
      expect(list).toContain(taken.details.source);

      const search = getToolResultText(run, "search-all");
      expect(search).toContain("shell:dev-server:1: catalog-needle-first");
      expect(search).toContain(`${taken.details.source}:1: catalog-needle-second`);

      expect(getToolExecution(run, "rename").isError).not.toBe(true);
      expect(getToolExecution(run, "read-renamed").isError).not.toBe(true);
      expect(getToolResultText(run, "read-renamed")).toContain("catalog-needle-first");
      expect(getToolExecution(run, "read-old").isError).toBe(true);
      expect(getToolExecution(run, "rename-invalid").isError).toBe(true);
      expect(getToolExecution(run, "delete-renamed").isError).toBe(false);
      expect(run.state?.isIdle).toBe(true);
    });
  },
  120_000,
);

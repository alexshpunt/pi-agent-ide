import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolExecutions,
  getToolResultText,
  PiIntegrationTest,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { afterAll, expect, test } from "vitest";
import type { FixtureRequest } from "./fixtures/serper-transport.ts";

const installedExtension = process.env.PI_WEB_SEARCH_INSTALLED_EXTENSION ?? "";
const localPiCommand = path.resolve(
  path.dirname(import.meta.dirname),
  "node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
const fixture = path.resolve(
  path.dirname(import.meta.dirname),
  "test/fixtures/serper-transport.ts",
);
const packageRoot = path.dirname(installedExtension);
const root = path.resolve(".agents", "tmp", "pi-web-search-packaged");
const workspaces: string[] = [];

type SurfaceReport = {
  tools: Array<{
    name: string;
    description: string;
    promptGuidelines?: readonly string[];
    sourceInfo: { path: string; source: string; scope: string; origin: string };
  }>;
  commands: Array<{ name: string; sourceInfo: { path: string } }>;
};

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const name = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(name) : [name];
    }),
  );
  return nested.flat();
}

afterAll(async () => {
  await Promise.all(workspaces.map((directory) => rm(directory, { recursive: true, force: true })));
  // Keep the surface report under .agents/tmp for reviewer inspection.
});

test.skipIf(!installedExtension)(
  "the exact installed archive has the approved package version",
  async () => {
    const installedPackage = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      name?: string;
      version?: string;
    };
    expect(installedPackage.name).toBe("pi-web-search");
    expect(installedPackage.version).toBe("0.1.0");
  },
);

test.skipIf(!installedExtension)(
  "runs the exact installed package in real Pi",
  async () => {
    const installedPackage = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    ) as {
      name?: string;
      version?: string;
      files?: string[];
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    expect(installedPackage.name).toBe("pi-web-search");
    expect(path.basename(packageRoot)).toBe("pi-web-search");
    expect(path.normalize(packageRoot)).toContain(
      path.join(".pi", "npm", "node_modules", "pi-web-search"),
    );
    expect(installedExtension).toBe(path.join(packageRoot, "index.ts"));
    expect(path.resolve(installedExtension)).not.toBe(
      path.resolve(path.dirname(import.meta.dirname), "index.ts"),
    );

    const installedFiles = await filesUnder(packageRoot);
    expect(installedFiles.some((file) => file.includes("test") || file.includes("fixture"))).toBe(
      false,
    );
    expect(
      installedFiles
        .filter((file) => path.basename(file).toLowerCase().startsWith("skill"))
        .map((file) => path.relative(packageRoot, file)),
    ).toEqual([path.join("skills", "configure-web-search", "SKILL.md")]);
    for (const file of installedFiles) {
      const content = await readFile(file, "utf8");
      expect(content).not.toContain(path.resolve("."));
      if (process.env.HOME) expect(content).not.toContain(path.join(process.env.HOME, ".herdr"));
    }
    expect(installedPackage.dependencies?.["pi-agent-ide"]).toBeDefined();
    expect(String(installedPackage.dependencies?.["pi-agent-ide"])).not.toMatch(/^workspace:/);
    expect(
      Object.values(installedPackage.devDependencies ?? {}).some((value) =>
        String(value).startsWith("workspace:"),
      ),
    ).toBe(false);
    expect(installedPackage.devDependencies ?? {}).not.toHaveProperty("pi-agent-search");

    await mkdir(root, { recursive: true });
    const surfaceReportPath = path.join(root, "surface-report.json");
    const cwd = await mkdtemp(path.join(root, "workspace-"));
    workspaces.push(cwd);
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "websearch.json"),
      JSON.stringify({
        providers: [
          { provider: "brave", apiKey: "demo" },
          { provider: "serper", apiKey: "demo" },
        ],
      }),
      "utf8",
    );

    const calls = [
      ["missing", "web_search", {}],
      ["empty", "web_search", { query: "" }],
      ["non-string", "web_search", { query: 42 }],
      ["extra", "web_search", { query: "query", extra: true }],
      ["limit", "web_search", { query: "query", limit: 1 }],
      ["plain", "web_search", { query: "Pi Search resolver architecture" }],
      ["images", "image_search", { query: "pi logo" }],
      ["both", "image_search", { query: "pi logo", image: "https://pics.example/pi.png" }],
    ] as const;
    const transportReportPath = path.join(cwd, "transport-report.json");
    const result = await new PiIntegrationTest({
      piCommand: localPiCommand,
      testName: "installed-web-search",
      cwd,
      extensions: [fixture, installedExtension],
      environment: {
        PI_CODING_AGENT_DIR: path.join(cwd, ".pi", "agent"),
        PI_WEB_SEARCH_SURFACE_REPORT: surfaceReportPath,
        PI_SERPER_FIXTURE_REPORT: transportReportPath,
      },
      isolateUserResources: true,
      conversation: [
        assistantMessage(
          calls.map(([id, name, arguments_]) => toolCall({ id, name, arguments: arguments_ })),
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Search completed")]),
      ],
    }).run("Search the public web");

    const surfaces = JSON.parse(await readFile(surfaceReportPath, "utf8")) as SurfaceReport;
    const packageTools = surfaces.tools.filter(
      (tool) => path.resolve(tool.sourceInfo.path) === path.resolve(installedExtension),
    );
    expect(packageTools.map((tool) => tool.name).sort()).toEqual([
      "image_search",
      "wait_for_web_searches",
      "web_search",
    ]);
    const packageCommands = surfaces.commands.filter(
      (command) => path.resolve(command.sourceInfo.path) === path.resolve(installedExtension),
    );
    expect(packageCommands.map((command) => command.name)).toEqual(["pi-web-search-doctor"]);

    for (const id of ["missing", "empty", "non-string", "extra", "both"]) {
      expect(getToolExecution(result, id).isError).toBe(true);
    }

    const limited = getToolExecution(result, "limit");
    expect(limited.isError).toBe(false);
    expect((getToolExecutionDetails(limited) as { results?: unknown[] }).results).toHaveLength(1);

    const plain = getToolExecution(result, "plain");
    expect(plain.isError).toBe(false);
    expect(getToolResultText(result, "plain")).toContain("Result 1");
    expect(getToolExecutionDetails(plain)).toMatchObject({
      provider: "serper",
      query: "Pi Search resolver architecture",
    });
    expect((getToolExecutionDetails(plain) as { results: unknown[] }).results).toHaveLength(10);

    const images = getToolExecution(result, "images");
    expect(images.isError).toBe(false);
    expect(getToolResultText(result, "images")).toContain("https://img.example/1.jpg");

    // Pi Agent IDE is not loaded, so no result resource is offered and nothing else breaks.
    expect(getToolExecutionDetails(plain)).not.toHaveProperty("resource");
    const requests = JSON.parse(await readFile(transportReportPath, "utf8")) as FixtureRequest[];
    expect(requests.every((request) => request.url.startsWith("https://google.serper.dev/"))).toBe(
      true,
    );
  },
  60_000,
);

test.skipIf(!installedExtension)(
  "cancelling the agent aborts the pending Serper request of the exact installed package",
  async () => {
    await mkdir(root, { recursive: true });
    const cwd = await mkdtemp(path.join(root, "cancellation-workspace-"));
    workspaces.push(cwd);
    await mkdir(path.join(cwd, ".pi"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "websearch.json"),
      JSON.stringify({ providers: [{ provider: "serper", apiKey: "demo" }] }),
      "utf8",
    );
    const transportReportPath = path.join(cwd, "cancellation-transport-report.json");

    const result = await new PiIntegrationTest({
      piCommand: localPiCommand,
      testName: "installed-cancel-search",
      cwd,
      extensions: [fixture, installedExtension],
      model: "scripted/scripted-model",
      environment: {
        PI_CODING_AGENT_DIR: path.join(cwd, ".pi", "agent"),
        PI_SERPER_FIXTURE_MODE: "hang",
        PI_SERPER_FIXTURE_REPORT: transportReportPath,
      },
      isolateUserResources: true,
      timeoutMs: 8_000,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "cancelled-search",
              name: "web_search",
              arguments: { query: "never finish" },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ],
    }).run("Start and then cancel web search");

    const requests = JSON.parse(await readFile(transportReportPath, "utf8")) as FixtureRequest[];
    expect(requests).toHaveLength(1);
    expect(requests[0]?.aborted).toBe(true);
    const cancelled = getToolExecution(result, "cancelled-search");
    expect(cancelled.isError).toBe(true);
    expect(
      getToolExecutions(result).filter((execution) => execution.toolCallId === "cancelled-search"),
    ).toHaveLength(1);
  },
  15_000,
);

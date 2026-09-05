import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRequire } from "node:module";
import type { Terminal as XtermTerminal } from "@xterm/headless";
const { Terminal } = createRequire(import.meta.url)("@xterm/headless") as {
  Terminal: typeof XtermTerminal;
};
import {
  assistantMessage,
  getToolResultMessage,
  PiIntegrationTest,
  PiRun,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test/base";
import { afterAll, expect, test } from "vitest";
import { forceStandaloneIntegrationFile } from "#integration/support/pi-runtime/standalone.js";

// Restart checks must replace a real process session, not the shared runner's session.
const restoreSharedRunner = forceStandaloneIntegrationFile();
afterAll(restoreSharedRunner);

const root = path.resolve();
const workspace = path.join(root, ".agents/tmp/compact-session-history/workspace");
const evidence = path.join(root, ".agents/tmp/compact-session-history/evidence");
const extensionRoot = process.env.IDE_HISTORY_EXTENSION_ROOT ?? root;
const baseline = process.env.IDE_HISTORY_BASELINE === "1";
const extensions = [
  path.join(extensionRoot, "src/pi-agent-ide.ts"),
  path.join(root, "tests/integration/fixtures/restore-tool-history.ts"),
];
const file = "history-fixture.txt";

for (const expanded of [false, true]) {
  for (const scenario of ["replace", "read", "search", "truncated-read"] as const) {
    const name = scenario === "truncated-read" ? "read" : scenario;
    test(`keeps ${scenario} history identical after restart (${expanded ? "expanded" : "compact"})`, async () => {
      await mkdir(workspace, { recursive: true });
      await mkdir(evidence, { recursive: true });
      const source =
        Array.from(
          { length: 1000 },
          (_, index) => `unchanged source line ${index.toString().padStart(4, "0")}`,
        ).join("\n") + "\n";
      const fixture =
        scenario === "truncated-read"
          ? Array.from({ length: 30 }, (_, i) => `${i} ${"long source text ".repeat(130)}`).join(
              "\n",
            )
          : source;
      await writeFile(path.join(workspace, file), fixture);
      const id = `${scenario}-${expanded ? "expanded" : "compact"}`;
      const arguments_ =
        scenario === "truncated-read"
          ? { path: file }
          : name === "replace"
            ? { path: file, start: "unchanged source line 0005", text: "changed source line five" }
            : name === "read"
              ? { path: file, offset: 4, limit: 8, views: ["anchors"] }
              : { query: "source line 0005", path: file };
      const options = {
        cwd: workspace,
        extensions,
        tools: [name],
        rawMode: false,
        isolateUserResources: true,
        artifactsDir: testArtifactsDir(
          import.meta.filename,
          path.join(root, ".agents/tmp/test-runs"),
        ),
        environment: { IDE_HISTORY_EXPANDED: expanded ? "1" : "0" },
        timeoutMs: 60000,
      };
      const runtime = await new PiIntegrationTest({
        ...options,
        testName: `${baseline ? "baseline" : "compact"}-${id}`,
        conversation: [
          assistantMessage([toolCall({ id, name, arguments: arguments_, delayMs: 0 })], {
            stopReason: "toolUse",
          }),
          assistantMessage([text("Finished", { delayMs: 0 })]),
        ],
      }).run("Show the history fixture");
      const message = getToolResultMessage(runtime, id);
      expect(message.isError).toBe(false);

      if (scenario === "truncated-read")
        expect(JSON.stringify(message.content)).toContain("Showing lines");
      const bytes = Buffer.byteLength(JSON.stringify(message));
      const panel = toolPanel(runtime.tuiRenderedOutput, name);

      const cells = await toolCells(runtime, name);
      await writeFile(
        path.join(evidence, `${baseline ? "baseline" : "runtime"}-${id}-cells.json`),
        JSON.stringify(cells),
      );
      expect(panel).toContain(file);
      const baselinePath = path.join(evidence, `${id}.json`);
      if (baseline) {
        await writeFile(baselinePath, JSON.stringify({ bytes, panel, cells }));
        return;
      }
      if (name === "replace") {
        const serialized = JSON.stringify(message.details);
        expect(serialized).not.toMatch(/beforeContentMap|afterContent|afterDocument|rawChanges/);
        expect(serialized).not.toContain("unchanged source line 0999");
        expect(bytes).toBeLessThan(5000);
      }
      try {
        const before = JSON.parse(await readFile(baselinePath, "utf8")) as {
          bytes: number;
          panel: string;
          cells: Awaited<ReturnType<typeof toolCells>>;
        };
        expect(panel).toEqual(before.panel);

        expect(cells).toEqual(before.cells);
        expect(bytes).toBeLessThan(before.bytes);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const sessionText = (await PiRun.open(runtime.artifacts.run)).session;
      if (sessionText === undefined) throw new Error("Missing persisted test session");
      const session = path.join(evidence, `${id}.jsonl`);
      await writeFile(session, sessionText);
      await rm(path.join(workspace, file));
      const resumed = await new PiIntegrationTest({
        ...options,
        testName: `resumed-${id}`,
        environment: { ...options.environment, IDE_RESTORE_SESSION: session },
        conversation: [assistantMessage([text("Restored", { delayMs: 0 })])],
      }).run("/restore-tool-history");
      expect(toolPanel(resumed.tuiRenderedOutput, name)).toEqual(panel);

      const restoredCells = await toolCells(resumed, name);
      expect(restoredCells).toEqual(cells);
      await writeFile(
        path.join(evidence, `resumed-${id}-cells.json`),
        JSON.stringify(restoredCells),
      );
      await writeFile(path.join(evidence, `${id}-size.json`), JSON.stringify({ bytes }));
    }, 120000);
  }
}

test("restores formatted multi-hunk batch results and errors without source files", async () => {
  await mkdir(workspace, { recursive: true });
  await mkdir(evidence, { recursive: true });
  const config = path.join(workspace, ".pi/pi-agent-ide");
  await mkdir(config, { recursive: true });
  const formatter = path.join(workspace, "format.mjs");
  await writeFile(
    formatter,
    'import fs from "node:fs"; const file=process.argv[2]; fs.writeFileSync(file, fs.readFileSync(file,"utf8").replaceAll("unformatted", "formatted"));',
  );
  await writeFile(
    path.join(config, "formatters.json"),
    JSON.stringify({
      version: 1,
      formatters: {
        fixture: {
          extensions: [".txt"],
          run: { command: ["node", formatter, "{file}"] },
          output: "in-place",
        },
      },
    }),
  );
  await writeFile(
    path.join(workspace, file),
    Array.from({ length: 30 }, (_, index) => `source line ${index}`).join("\n") + "\n",
  );
  const options = {
    cwd: workspace,
    extensions,
    tools: ["replace"],
    rawMode: false,
    isolateUserResources: true,
    artifactsDir: testArtifactsDir(import.meta.filename, path.join(root, ".agents/tmp/test-runs")),
    environment: { IDE_HISTORY_EXPANDED: "1", TMUX: "" },
    timeoutMs: 60000,
  };
  try {
    const runtime = await new PiIntegrationTest({
      ...options,
      testName: `${baseline ? "baseline" : "compact"}-formatted-batch`,
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "batch-first",
              name: "replace",
              arguments: { path: file, start: "source line 5", text: "unformatted first" },
              delayMs: 0,
            }),
            toolCall({
              id: "batch-last",
              name: "replace",
              arguments: { path: file, start: "source line 25", text: "unformatted last" },
              delayMs: 0,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          [
            toolCall({
              id: "batch-error",
              name: "replace",
              arguments: { path: file, start: "absent anchor", text: "never written" },
              delayMs: 0,
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([text("Finished", { delayMs: 0 })]),
      ],
    }).run("Edit two distant lines and report a missing anchor");
    expect(getToolResultMessage(runtime, "batch-first").isError).toBe(false);
    expect(getToolResultMessage(runtime, "batch-last").isError).toBe(false);
    expect(getToolResultMessage(runtime, "batch-error").isError).toBe(true);
    expect(await readFile(path.join(workspace, file), "utf8")).toContain("formatted last");
    expect(await readFile(path.join(workspace, file), "utf8")).not.toContain("unformatted");
    const rows = await toolCells(runtime, "replace");
    const reference = path.join(evidence, "formatted-batch.json");
    if (baseline) {
      await writeFile(reference, JSON.stringify(rows));
      return;
    }
    try {
      const previous = JSON.parse(await readFile(reference, "utf8")) as typeof rows;
      expect(rows).toEqual(previous);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const sessionText = (await PiRun.open(runtime.artifacts.run)).session;
    if (sessionText === undefined) throw new Error("Missing persisted session");
    expect(sessionText).not.toContain('"beforeContentMap"');
    const session = path.join(evidence, "formatted-batch.jsonl");
    await writeFile(session, sessionText);
    await rm(path.join(workspace, file));
    const resumed = await new PiIntegrationTest({
      ...options,
      testName: "resumed-formatted-batch",
      environment: { ...options.environment, IDE_RESTORE_SESSION: session },
      conversation: [assistantMessage([text("Restored", { delayMs: 0 })])],
    }).run("/restore-tool-history");
    expect(await toolCells(resumed, "replace")).toEqual(rows);
    expect(resumed.tuiRenderedOutput).toContain("absent anchor");
  } finally {
    await rm(path.join(config, "formatters.json"), { force: true });
    await rm(formatter, { force: true });
  }
}, 120000);

function toolPanel(screen: string, name: string): string {
  const lines = screen.split("\n");
  const start = lines.findIndex((line) => line.trimStart().startsWith(`${name} `));
  const last = lines.findIndex(
    (line, index) =>
      index > start &&
      (name === "replace" ? /^\+\d+ ~\d+ -\d+$/u.test(line.trim()) : line.trimEnd().endsWith("╯")),
  );
  const end = last < 0 ? -1 : last + 1;
  if (start < 0 || end < 0) throw new Error(`Missing ${name} panel:\n${screen}`);
  return lines
    .slice(start, end)
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

/** Replays real PTY bytes and keeps both characters and cell styles for the tool panel. */
async function toolCells(
  run: PiRun,
  name: string,
): Promise<readonly (readonly (readonly (string | number)[])[])[]> {
  const terminal = new Terminal({ ...run.tuiSize, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => terminal.write(run.terminalOutput, resolve));
    const buffer = terminal.buffer.active;
    const rows = Array.from(
      { length: buffer.length },
      (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
    );
    const panel = toolPanel(rows.join("\n"), name).split("\n");
    const start = rows.findIndex((line) => line.trimStart().startsWith(`${name} `));
    return panel.map((_, row) =>
      Array.from({ length: run.tuiSize.cols }, (_, col) => {
        const cell = buffer.getLine(start + row)?.getCell(col);
        if (cell === undefined) throw new Error("Missing terminal cell");
        return [
          cell.getChars(),
          cell.getWidth(),
          cell.getFgColorMode(),
          cell.getFgColor(),
          cell.getBgColorMode(),
          cell.getBgColor(),
          cell.isBold(),
          cell.isItalic(),
          cell.isUnderline(),
          cell.isInverse(),
        ];
      }),
    );
  } finally {
    terminal.dispose();
  }
}

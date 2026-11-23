import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.ts";
import {
  PiIntegrationTest,
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  testArtifactsDir,
  text,
  toolCall,
} from "#integration/support/pi-runtime/native-pi-coding-agent-test.ts";
import { expect, test } from "vitest";

const available = (command: string, argument: string) =>
  spawnSync(command, [argument], { stdio: "ignore" }).status === 0;
const allMatches = /SEARCH#\S+:all:match/u;

async function checkLimit(fixture: {
  server: string;
  variant?: string;
  files: Record<string, string>;
  path: string;
  query: string;
  narrowQuery: string;
  uncappedQuery?: string;
  limit: number;
  match: string;
}) {
  await withTempWorkspace(async (cwd) => {
    for (const [source, content] of Object.entries(fixture.files)) {
      const file = path.join(cwd, source);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    await enableNativeCodemode(cwd);
    const broad = { query: fixture.query, path: fixture.path, limit: 200 };
    const narrow = { ...broad, query: fixture.narrowQuery };
    const control = { ...broad, query: fixture.uncappedQuery ?? fixture.narrowQuery };
    const caps = [{ server: fixture.server, limit: fixture.limit }];
    const code = `
const result = await tools.lsp_search(${JSON.stringify(broad)});
if (result?.complete !== false || JSON.stringify(result.candidateLimits) !== ${JSON.stringify(JSON.stringify(caps))} ||
    result.matches.length !== 1 || result.matches[0].text !== ${JSON.stringify(fixture.match)}) throw Error(JSON.stringify(result));`;
    const run = await new PiIntegrationTest({
      testName: `workspace-candidate-limit-${fixture.variant ?? fixture.server}`,
      cwd,
      isolateUserResources: true,
      artifactsDir: testArtifactsDir(import.meta.filename),
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["lsp_search", "codemode"],
      environment: { PI_AGENT_IDE_LSP_LINGER_MS: "0", CARGO_NET_OFFLINE: "true" },
      rawMode: false,
      timeoutMs: 120_000,
      conversation: [
        assistantMessage([toolCall({ id: "broad", name: "lsp_search", arguments: broad })], {
          stopReason: "toolUse",
        }),
        assistantMessage([toolCall({ id: "narrow", name: "lsp_search", arguments: narrow })], {
          stopReason: "toolUse",
        }),
        assistantMessage([toolCall({ id: "control", name: "lsp_search", arguments: control })], {
          stopReason: "toolUse",
        }),
        assistantMessage([toolCall({ id: "script", name: "codemode", arguments: { code } })], {
          stopReason: "toolUse",
        }),
        assistantMessage([text("Done")]),
      ],
    }).run("Find the matching declarations and references in the target file.");
    for (const id of ["broad", "narrow", "control"])
      expect(getToolExecution(run, id).isError, getToolResultText(run, id)).toBe(false);
    const { payload: broadResult } = getToolExecutionDetails(getToolExecution(run, "broad")) as {
      payload: { complete: boolean; hits: readonly { matchedText: string }[] };
    };
    expect(broadResult.hits.map(({ matchedText }) => matchedText)).toEqual([fixture.match]);
    expect(getToolResultText(run, "narrow")).toContain(fixture.narrowQuery);
    expect(getToolResultText(run, "control")).toMatch(allMatches);
    expect(broadResult.complete).toBe(false);
    expect(getToolResultText(run, "broad")).not.toMatch(allMatches);
    expect(run.tuiRenderedOutput).toContain(fixture.server);
    expect(getToolExecution(run, "script").isError, getToolResultText(run, "script")).toBe(false);
  });
}

test.runIf(available("gopls", "version") && available("go", "version"))(
  "reports a capped Go search when higher ranked candidates displace a match in the selected file",
  () =>
    checkLimit({
      server: "gopls",
      path: "target.go",
      query: "'Cap",
      narrowQuery: "LongDisplacedDeclarationInTargetCap",
      uncappedQuery: "StandaloneControl",
      limit: 100,
      match: "Cap",
      files: {
        "go.mod": "module example.com/capped\n\ngo 1.24\n",
        "decoys.go":
          "package capped\n\nconst Cap = 1\n" +
          Array.from({ length: 110 }, (_, i) => `const Cap${i} = 1\n`).join(""),
        "target.go":
          "package capped\n\ntype Holder struct { LongDisplacedDeclarationInTargetCap int }\n\nvar _ = Cap\n\nconst StandaloneControl = 1\n",
      },
    }),
  150_000,
);

test
  .runIf(available("rust-analyzer", "--version") && available("cargo", "--version"))
  .each(["initializationOptions", "settings"])(
  "reports the rust-analyzer cap from %s before applying the file scope",
  (source) => {
    const options = {
      checkOnSave: false,
      cargo: { buildScripts: { enable: false } },
      procMacro: { enable: false },
    };
    const capped = {
      ...options,
      workspace: { symbol: { search: { limit: 2, excludeImports: true } } },
    };
    return checkLimit({
      server: "rust-analyzer",
      variant: `rust-analyzer-${source}`,
      path: "src/lib.rs",
      query: "Rank",
      narrowQuery: "RankZ",
      limit: 2,
      match: "RankA",
      files: {
        "Cargo.toml": '[package]\nname = "capped"\nversion = "0.1.0"\nedition = "2021"\n',
        "src/lib.rs": "mod decoys;\npub use decoys::RankA;\npub struct RankZ;\n",
        "src/decoys.rs": "pub struct RankA;\npub struct RankB;\n",
        ".pi/pi-agent-ide/lsp-servers.json": JSON.stringify({
          version: 1,
          servers: {
            "rust-analyzer": {
              command: ["rust-analyzer"],
              rootMarkers: ["Cargo.toml"],
              languages: { rust: { extensions: [".rs"] } },
              capabilities: ["diagnostics"],
              initializationOptions: source === "initializationOptions" ? capped : options,
              ...(source === "settings" && { settings: { "rust-analyzer": capped } }),
            },
          },
        }),
      },
    });
  },
  150_000,
);

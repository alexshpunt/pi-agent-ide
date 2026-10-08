import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshLspWorkspaceOwner } from "#src/backend/lsp-workspace-owner.js";
import { LspServerRegistry } from "#src/plugins/pi-agent-ide-lsp/src/lsp/registry.js";
import { LspManager } from "#src/plugins/pi-agent-ide-lsp/src/lsp/manager.js";
import { searchSymbols } from "#src/plugins/pi-agent-ide-lsp/src/lsp/symbol-search.js";

test("owned symbol search includes references and never treats a server error as empty", async () => {
  const fixture = await startSshFixture();
  const root = `ssh://fixture${fixture.workspace}`;
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const backend = registry.resolve(root)?.backend;
  if (!backend) throw new Error("Missing owner");
  const config = LspServerRegistry.fromConfig(
    {
      version: 1,
      servers: {
        owned: {
          command: ["python3", `${fixture.workspace}/server.py`],
          rootMarkers: [],
          languages: { typescript: { extensions: [".ts"] } },
          capabilities: ["diagnostics"],
        },
      },
    },
    root,
  );
  const manager = LspManager.init(config, createSshLspWorkspaceOwner(registry));
  try {
    await backend.write(
      `${fixture.workspace}/server.py`,
      await readFile("tests/integration/fixtures/lsp-owner-server.py"),
      null,
    );
    for (const name of ["note.ts", "reference.ts"])
      await backend.write(
        `${fixture.workspace}/${name}`,
        Buffer.from('const label = "café";\n'),
        null,
      );
    const hits = await searchSymbols("label", root, 50, undefined, {}, manager);
    expect(hits.complete).toBe(true);
    expect(hits.hits.map((hit) => hit.source)).toEqual([`${root}/note.ts`, `${root}/reference.ts`]);
    const content = (await backend.read(`${fixture.workspace}/note.ts`)).bytes.toString("utf8");
    const resultScope = {
      complete: true,
      targets: [
        {
          source: `${root}/note.ts`,
          expectedContent: content,
          readCurrent: async (signal?: AbortSignal) =>
            (await backend.read(`${fixture.workspace}/note.ts`, { signal })).bytes.toString("utf8"),
          ranges: [{ start: { lineNumber: 1, column: 6 }, end: { lineNumber: 1, column: 11 } }],
        },
      ],
    };
    const strict = await searchSymbols("label", root, 50, undefined, { resultScope }, manager);
    expect(strict.complete).toBe(true);
    expect(strict.hits).toHaveLength(1);
    expect(strict.hits[0]).toMatchObject({
      source: `${root}/note.ts`,
      role: "definition",
      matchedText: "label",
      startColumn: 6,
      endColumn: 11,
    });
    const navigation = await searchSymbols(
      "label",
      root,
      50,
      undefined,
      { resultScope, navigation: "references" },
      manager,
    );
    expect(navigation.hits.map((hit) => hit.source)).toEqual([
      `${root}/note.ts`,
      `${root}/reference.ts`,
    ]);
    expect(new Set(navigation.hits.map((hit) => hit.symbol.id)).size).toBe(1);
    expect(navigation.hits[1]?.role).toBe("reference");
    const incomplete = await searchSymbols(
      "label",
      root,
      50,
      undefined,
      { resultScope: { ...resultScope, complete: false } },
      manager,
    );
    expect(incomplete.complete).toBe(false);
    await expect(searchSymbols("broken", root, 50, undefined, {}, manager)).rejects.toThrow(
      "Owned navigation failure",
    );
  } finally {
    await manager.shutdownAll();
    await fixture.stop();
  }
}, 30000);

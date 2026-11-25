/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NamedConnections } from "#axi/named-connections.ts";
import { isUnknownArray } from "#axi/types.ts";
import { fixtureRecord, jsonRecord } from "./fixtures/json.ts";

const windows = process.platform === "win32";

void test(
  "Windows opens private connections when the parent supplies incompatible PowerShell modules",
  { skip: !windows },
  async () => {
    const directory = await mkdtemp(join(homedir(), "linear-windows-modules-"));
    const file = join(directory, "connection.json");
    const modules = join(directory, "modules");
    const shadow = join(modules, "Microsoft.PowerShell.Security");
    try {
      await mkdir(shadow, { recursive: true });
      await writeFile(
        join(shadow, "Microsoft.PowerShell.Security.psd1"),
        "@{ ModuleVersion = '7.0.0.0'; CompatiblePSEditions = @('Core'); PowerShellVersion = '3.0'; CmdletsToExport = @('Get-Acl'); NestedModules = 'missing.dll' }",
      );
      const connection = new NamedConnections({
        env: { LINEAR_AXI_CONNECTION_FILE: file },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              data: {
                viewer: {
                  id: "user",
                  name: "Fixture",
                  organization: { id: "org", name: "Fixture", urlKey: "fixture" },
                },
              },
            }),
          ),
      });
      await connection.importCredential({
        type: "api-key",
        token: "fixture-secret",
        name: "Fixture",
      });
      const script = `import { NamedConnections } from ${JSON.stringify(import.meta.resolve("#axi/named-connections.ts"))}; const value = await new NamedConnections({env: process.env}).list(); console.log(JSON.stringify(value));`;
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: {
          ...process.env,
          LINEAR_AXI_CONNECTION_FILE: file,
          PSModulePath: `${modules};${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
        },
        encoding: "utf8",
        timeout: 30000,
      });
      const { connections } = jsonRecord(output);
      assert(isUnknownArray(connections));
      assert.equal(fixtureRecord(connections[0]).name, "Fixture");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

import { expect, test } from "vitest";
import { startSshFixture } from "#integration/support/ssh-fixture.js";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { remoteLocation } from "#src/backend/identity.js";
import { readSshProcessMetadata } from "#src/backend/process-metadata.js";
import { createSshDebuggerWorkspaceOwner } from "#src/backend/debugger-workspace-owner.js";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";

const cases = [
  {
    adapter: "powershell" as const,
    script: process.env.PI_IDE_POWERSHELL_SERVICES,
    envKey: "PI_POWERSHELL_EDITOR_SERVICES_PATH",
    file: "note-café.ps1",
    content: '$value = 42\n$value += 1\nWrite-Output "café $value"\n',
    line: 2,
    value: "$value",
    pid: "$PID",
  },
  {
    adapter: "php" as const,
    script: process.env.PI_IDE_PHP_DEBUG,
    envKey: "PI_PHP_DEBUG_PATH",
    file: "note-café.php",
    content:
      '<?php\n$value = 42;\n$pid = getmypid();\n$value += 1;\necho "café " . $value . "\\n";\n',
    line: 4,
    value: "$value",
    pid: "$pid",
  },
  {
    adapter: "lua" as const,
    script: process.env.PI_IDE_LUA_DEBUG,
    envKey: "PI_LUA_DEBUG_PATH",
    file: "note-café.lua",
    content:
      'local stream = assert(io.open("/proc/self/stat", "r"))\nlocal pid = tonumber(stream:read("*l"):match("^(%d+)"))\nstream:close()\nlocal value = 42\nvalue = value + 1\nprint("café", value)\n',
    line: 5,
    value: "value",
    pid: "pid",
  },
  {
    adapter: "shell" as const,
    script: process.env.PI_IDE_BASH_DEBUG,
    envKey: "PI_BASH_DEBUG_PATH",
    file: "note-café.sh",
    content:
      '#!/usr/bin/env bash\nvalue=42\npid=$$\nvalue=$((value + 1))\nprintf "café %s\\n" "$value"\n',
    line: 4,
    value: "$value",
    pid: "$pid",
  },
];

for (const item of cases) {
  test.skipIf(!item.script)(
    `real target ${item.adapter} verifies its breakpoint, steps and removes its debuggee`,
    async () => {
      if (!item.script) throw new Error("Missing explicitly selected installed adapter");
      const fixture = await startSshFixture(
        {},
        {
          [item.envKey]: item.script,
          // Keep PowerShell's configuration and caches inside the owned fixture, not the account home.
          ...(item.adapter === "powershell"
            ? {
                XDG_CONFIG_HOME: "{workspace}/config",
                XDG_CACHE_HOME: "{workspace}/cache",
                XDG_DATA_HOME: "{workspace}/data",
              }
            : {}),
        },
      );
      const registry = new SshBackendRegistry([
        {
          id: "fixture",
          host: "fixture",
          workspace: fixture.workspace,
          configFile: fixture.config,
        },
      ]);
      const scope = `ssh://fixture${fixture.workspace}`;
      const owner = registry.resolve(scope);
      if (!owner) throw new Error("Missing source owner");
      const manager = new DebugSessionManager(createSshDebuggerWorkspaceOwner(registry));
      try {
        const native = `${fixture.workspace}/${item.file}`;
        await owner.backend.write(native, Buffer.from(item.content), null);
        const resource = remoteLocation("fixture", native).source;
        const session = manager.create({
          adapter: item.adapter,
          cwd: scope,
          program: resource,
          args: [],
        });
        await manager.addBreakpoint(manager.sourceResource(session), item.line);
        await manager.start(session);
        expect(session.status).toBe("stopped");
        expect(session.stop?.frame?.source?.path).toBe(resource);
        expect([...session.breakpoints.values()][0]?.verified).toBe(true);
        expect((await manager.evaluate(session, item.value)).result).toMatch(/\b42\b/u);
        const pidResult = (await manager.evaluate(session, item.pid)).result;
        // Bashdb quotes evaluated strings. Keep its display unchanged and parse only a PID.
        const matched = /^(?:([0-9]+)|'([0-9]+)')$/u.exec(pidResult);
        const pid = Number(matched?.[1] ?? matched?.[2]);
        expect(Number.isSafeInteger(pid), pidResult).toBe(true);
        const generation = session.stopGeneration;
        await manager.command(session, "next");
        expect(
          session.stopGeneration,
          `${session.status}: line ${session.stop?.frame?.line}`,
        ).toBeGreaterThan(generation);
        expect((await manager.evaluate(session, item.value)).result).toMatch(/\b43\b/u);
        await manager.delete(session.source);
        await expect(readSshProcessMetadata(registry, scope, pid)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        try {
          await manager.dispose();
        } finally {
          await fixture.stop();
        }
      }
    },
    45000,
  );
}

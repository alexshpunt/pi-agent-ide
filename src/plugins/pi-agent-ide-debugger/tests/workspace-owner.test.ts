import { expect, test } from "vitest";
import { DebugSessionManager } from "#src/plugins/pi-agent-ide-debugger/src/session-manager.js";
import type { DebugWorkspaceOwner } from "#src/plugins/pi-agent-ide-debugger/src/workspace-owner.js";

function owner(key: string, readText: DebugWorkspaceOwner["readText"]): DebugWorkspaceOwner {
  return {
    key,
    readText,
    serverPath: (source) => source.replace("ssh://fixture", ""),
    resourcePath: (source) => `ssh://fixture${source}`,
    prepare: () => Promise.reject(new Error("No adapter requested")),
  };
}

test("debug source reads use their workspace owner and refuse a rebound session before contact", async () => {
  const reads: string[] = [];
  let binding = owner("first", async (source) => {
    reads.push(source);
    return 'label = "café"\n';
  });
  const manager = new DebugSessionManager(() => binding);
  const session = manager.create({
    adapter: "debugpy",
    program: "ssh://fixture/owned/note.py",
    cwd: "ssh://fixture/owned",
    args: [],
  });
  await expect(manager.readSource(manager.sourceResource(session))).resolves.toBe(
    'label = "café"\n',
  );
  binding = owner("second", async () => {
    throw new Error("Rebound backend contacted");
  });
  await expect(manager.readSource(manager.sourceResource(session))).rejects.toThrow(
    "resource owner changed",
  );
  expect(reads).toEqual(["ssh://fixture/owned/note.py"]);
  await manager.dispose();
});

test("a standalone debugger never treats an SSH source as a controller file", () => {
  const manager = new DebugSessionManager();
  expect(() =>
    manager.create({
      adapter: "debugpy",
      program: "ssh://fixture/owned/note.py",
      cwd: "ssh://fixture/owned",
      args: [],
    }),
  ).toThrow("No debugger workspace owner");
});

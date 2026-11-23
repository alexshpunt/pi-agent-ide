import { describe, expect, test } from "vitest";
import { SshBackendError } from "./ssh.ts";
import { createSshDebuggerWorkspaceOwner } from "./debugger-workspace-owner.ts";
import { SshBackendRegistry } from "./registry.ts";

const registry = new SshBackendRegistry([
  { id: "win", host: "win", os: "windows", workspace: "C:/work" },
  { id: "linux", host: "linux", workspace: "/work" },
]);
const resolveOwner = createSshDebuggerWorkspaceOwner(registry);

describe("SSH debugger file paths", () => {
  test("maps Windows paths in both directions without controller path rules", () => {
    const cwd = "ssh://win/C:/work";
    const owner = resolveOwner(cwd);
    if (!owner) throw new Error("Missing debugger owner");
    const source = `${cwd}/a%20%23%20x.py`;
    expect(owner.serverPath(source)).toBe("C:\\work\\a # x.py");
    expect(owner.resourcePath("c:\\work\\a # x.py")).toBe(source);
    expect(() => owner.resourcePath("C:a.py")).toThrow(SshBackendError);
    expect(() => owner.resourcePath("\\\\server\\share\\a.py")).toThrow(SshBackendError);
    expect(() => owner.serverPath("ssh://linux/work/a.py")).toThrow(SshBackendError);
  });

  test("preserves absolute Linux paths and rejects relative adapter paths", () => {
    const cwd = "ssh://linux/work";
    const owner = resolveOwner(cwd);
    if (!owner) throw new Error("Missing debugger owner");
    expect(owner.serverPath(`${cwd}/a%20b.py`)).toBe("/work/a b.py");
    expect(owner.resourcePath("/work/a b.py")).toBe(`${cwd}/a%20b.py`);
    expect(() => owner.resourcePath("a.py")).toThrow(SshBackendError);
  });
});

import path from "node:path";
import { expect, test } from "vitest";
import { SshBackendRegistry } from "#src/backend/registry.js";
import { createSshSearchEnvironmentProvider } from "#src/backend/search-environment.js";
import { startSshFixture } from "#integration/support/ssh-fixture.js";

test("remote search preserves long Unicode lines within the text snapshot bound", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const resolved = registry.resolve(scope);
  if (resolved === undefined) throw new Error("Missing fixture backend");
  try {
    const content = "café needle " + "aĀ".repeat(700000) + "\n";
    await resolved.backend.write(
      path.join(fixture.workspace, "long.txt"),
      Buffer.from(content),
      null,
    );
    const environment = createSshSearchEnvironmentProvider(registry)(
      { query: "needle", path: scope },
      { cwd: fixture.workspace },
    );
    if (environment === undefined) throw new Error("Missing search environment");
    const matches: string[] = [];
    const result = await environment.runLines(
      ["--json", "--fixed-strings", "--", "needle", "./long.txt"],
      scope,
      (line) => {
        const event = JSON.parse(line) as { type?: string; data?: { lines?: { text?: string } } };
        if (event.type === "match" && event.data?.lines?.text !== undefined)
          matches.push(event.data.lines.text);
      },
    );
    expect(result.code).toBe(0);
    expect(matches).toEqual([content]);
  } finally {
    await fixture.stop();
  }
});

// Complete the real remote process before handing its channel back to the caller.
// This makes the short-process/EOF race deterministic without mocking modules.
test("a completed remote search does not fail while closing unused stdin", async () => {
  const fixture = await startSshFixture();
  const registry = new SshBackendRegistry([
    { id: "fixture", host: "fixture", workspace: fixture.workspace, configFile: fixture.config },
  ]);
  const scope = `ssh://fixture${fixture.workspace}`;
  const resolved = registry.resolve(scope);
  if (resolved === undefined) throw new Error("Missing fixture backend");
  try {
    await resolved.backend.write(
      path.join(fixture.workspace, "note.txt"),
      Buffer.from("needle\n"),
      null,
    );
    const startProcess = resolved.backend.startProcess.bind(resolved.backend);
    resolved.backend.startProcess = async (...arguments_) => {
      const channel = await startProcess(...arguments_);
      await channel.completion;
      return channel;
    };
    const environment = createSshSearchEnvironmentProvider(registry)(
      { query: "files:*.txt", path: scope },
      { cwd: fixture.workspace },
    );
    if (environment === undefined) throw new Error("Missing search environment");
    const lines: string[] = [];
    await expect(
      environment.runLines(["--files", "--", "."], scope, (line) => lines.push(line)),
    ).resolves.toMatchObject({ code: 0 });
    expect(lines).toContain("./note.txt");
  } finally {
    await fixture.stop();
  }
});

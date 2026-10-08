import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import {
  enableNativeCodemode,
  withTempWorkspace,
} from "#integration/support/pi-runtime/fixtures.js";

// Use the existing Delete integration pattern: real tools, isolated Git, and both call routes.
test("transfers trees and standalone links with merge and replace semantics through both routes", async () => {
  await withTempWorkspace(async (cwd) => {
    execFileSync("git", ["init", "-q", cwd]);
    await enableNativeCodemode(cwd);
    await writeFile(path.join(cwd, "sentinel.ts"), "const sentinel= 1; // untouched\n");
    const calls = [];
    for (const route of ["direct", "script"] as const) {
      const source = `${route}-source`;
      const copied = `${route}-copied`;
      const moved = `${route}-new/parents/moved`;
      for (const directory of [`${source}/nested/empty`, `${copied}/nested`, moved])
        await mkdir(path.join(cwd, directory), { recursive: true });
      await writeFile(path.join(cwd, source, "nested", "data.bin"), Buffer.from([0, 255, 10]));
      await symlink(path.join(cwd, "sentinel.ts"), path.join(cwd, source, "link"));
      await symlink("missing", path.join(cwd, source, "broken"));
      await writeFile(path.join(cwd, copied, "nested", "data.bin"), "old");
      await writeFile(path.join(cwd, copied, "copy-only"), "retained");
      await writeFile(path.join(cwd, moved, "move-only"), "removed");
      for (const [name, referent] of [
        ["link", "sentinel.ts"],
        ["broken", "missing"],
      ] as const)
        await symlink(referent, path.join(cwd, `${route}-${name}`));
      const transfers = [
        { name: "copy", arguments: { path: source, target: copied } },
        { name: "move", arguments: { path: copied, target: moved } },
        ...["link", "broken"].flatMap((name) => [
          {
            name: "copy",
            arguments: { path: `${route}-${name}`, target: `${route}-links/copied-${name}` },
          },
          {
            name: "move",
            arguments: {
              path: `${route}-links/copied-${name}`,
              target: `${route}-links/moved-${name}`,
            },
          },
        ]),
      ];
      if (route === "direct") {
        calls.push(...transfers.map((transfer, i) => toolCall({ id: `direct-${i}`, ...transfer })));
      } else {
        calls.push(
          toolCall({
            id: "script-transfers",
            name: "codemode",
            arguments: {
              code: transfers
                .map(
                  ({ name, arguments: args }) =>
                    `text(await tools.${name}(${JSON.stringify(args)}));`,
                )
                .join("\n"),
            },
          }),
        );
      }
    }
    const run = await new PiIntegrationTest({
      testName: "directory-transfers-both-routes",
      // Preserve broken-link fixtures in place; shared TUI workspace sync cannot copy them back.
      transport: "rpc",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: ["builtin:codemode", path.resolve("src/pi-agent-ide.ts")],
      tools: ["copy", "move", "codemode"],
      conversation: [
        ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
        assistantMessage([text("Done")]),
      ],
    }).run("Transfer directories and link objects without following links");
    for (const call of calls) expect(getToolExecution(run, call.id).isError).toBe(false);
    expect(getToolResultText(run, "direct-0")).not.toContain("Post-processing failed");
    for (const route of ["direct", "script"]) {
      const moved = path.join(cwd, `${route}-new/parents/moved`);
      expect(await readFile(path.join(moved, "nested", "data.bin"))).toEqual(
        Buffer.from([0, 255, 10]),
      );
      expect((await lstat(path.join(moved, "nested", "empty"))).isDirectory()).toBe(true);
      expect(await readlink(path.join(moved, "link"))).toBe(path.join(cwd, "sentinel.ts"));
      expect(await readlink(path.join(moved, "broken"))).toBe("missing");
      expect(await readFile(path.join(moved, "copy-only"), "utf8")).toBe("retained");
      await expect(lstat(path.join(moved, "move-only"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(lstat(path.join(cwd, `${route}-copied`))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(path.join(cwd, `${route}-source`, "nested", "data.bin"))).toEqual(
        Buffer.from([0, 255, 10]),
      );
      for (const [name, referent] of [
        ["link", "sentinel.ts"],
        ["broken", "missing"],
      ] as const) {
        expect(await readlink(path.join(cwd, `${route}-links/moved-${name}`))).toBe(referent);
        expect(await readlink(path.join(cwd, `${route}-${name}`))).toBe(referent);
        await expect(lstat(path.join(cwd, `${route}-links/copied-${name}`))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    }
    expect(await readFile(path.join(cwd, "sentinel.ts"), "utf8")).toBe(
      "const sentinel= 1; // untouched\n",
    );
  });
});

test("Move source and replacement gates cannot be bypassed through native Codemode", async () => {
  await withTempWorkspace(async (cwd) => {
    execFileSync("git", ["init", "-q", cwd]);
    await enableNativeCodemode(cwd);
    const calls = [];
    for (const route of ["direct", "script"] as const) {
      for (const decision of ["no", "yes"] as const) {
        for (const role of ["source", "target"]) {
          const name = `${route}-${role}-tracked-${decision}`;
          await mkdir(path.join(cwd, name));
          await writeFile(path.join(cwd, name, "data"), role);
        }
        const args = {
          path: `${route}-source-tracked-${decision}`,
          target: `${route}-target-tracked-${decision}`,
        };
        calls.push(
          route === "direct"
            ? toolCall({ id: `direct-${decision}`, name: "move", arguments: args })
            : toolCall({
                id: `script-${decision}`,
                name: "codemode",
                arguments: {
                  code:
                    decision === "no"
                      ? `let refused=false; try { await tools.move(${JSON.stringify(args)}); } catch { refused=true; } if(!refused) throw Error("Move bypassed refusal"); text("refused");`
                      : `text(await tools.move(${JSON.stringify(args)}));`,
                },
              }),
        );
      }
    }
    execFileSync("git", [
      "-C",
      cwd,
      "add",
      "direct-source-tracked-no",
      "direct-target-tracked-no",
      "direct-source-tracked-yes",
      "direct-target-tracked-yes",
      "script-source-tracked-no",
      "script-target-tracked-no",
      "script-source-tracked-yes",
      "script-target-tracked-yes",
    ]);
    const run = await new PiIntegrationTest({
      testName: "directory-move-host-gates",
      rawMode: false,
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        "builtin:codemode",
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/delete-dialog-extension.ts"),
      ],
      tools: ["move", "codemode"],
      conversation: [
        ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
        assistantMessage([text("Done")]),
      ],
    }).run("Move only objects approved by the host user");
    expect(getToolExecution(run, "direct-no").isError).toBe(true);
    for (const id of ["direct-yes", "script-no", "script-yes"])
      expect(getToolExecution(run, id).isError).toBe(false);
    for (const route of ["direct", "script"]) {
      expect(await readFile(path.join(cwd, `${route}-source-tracked-no`, "data"), "utf8")).toBe(
        "source",
      );
      expect(await readFile(path.join(cwd, `${route}-target-tracked-no`, "data"), "utf8")).toBe(
        "target",
      );
      expect(await readFile(path.join(cwd, `${route}-target-tracked-yes`, "data"), "utf8")).toBe(
        "source",
      );
      await expect(lstat(path.join(cwd, `${route}-source-tracked-yes`))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
    const decisions = (await readFile(path.join(cwd, "dialog-decisions.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { message: string; approved: boolean });
    expect(decisions.map(({ approved }) => approved)).toEqual([
      false,
      true,
      true,
      false,
      true,
      true,
    ]);
  });
});

test("transfer refusals and deletion hooks leave both paths unchanged on both routes", async () => {
  await withTempWorkspace(async (cwd) => {
    execFileSync("git", ["init", "-q", cwd]);
    await enableNativeCodemode(cwd);
    await writeFile(path.join(cwd, "sentinel"), "untouched");
    await symlink("sentinel", path.join(cwd, "link"));
    for (const name of ["source", "locked-delete", "throw-delete", "target-locked-delete"]) {
      await mkdir(path.join(cwd, name));
      await writeFile(path.join(cwd, name, "data"), "keep");
    }
    const transfers = [
      { name: "copy", arguments: { path: "source", target: "source/new" } },
      { name: "copy", arguments: { path: "source", target: "link" } },
      { name: "move", arguments: { path: "source", target: ".git" } },
      { name: "move", arguments: { path: ".git/config", target: "new" } },
      { name: "move", arguments: { path: "locked-delete", target: "new" } },
      { name: "move", arguments: { path: "throw-delete", target: "new" } },
      { name: "move", arguments: { path: "source", target: "target-locked-delete" } },
    ];
    const calls = transfers.map((transfer, i) => toolCall({ id: `refusal-${i}`, ...transfer }));
    calls.push(
      toolCall({
        id: "script-refusals",
        name: "codemode",
        arguments: {
          code: transfers
            .map(
              ({ name, arguments: args }) =>
                `try { await tools.${name}(${JSON.stringify(args)}); throw Error("Unexpected transfer success"); } catch(e) { if(String(e).includes("Unexpected transfer success")) throw e; text(String(e)); }`,
            )
            .join("\n"),
        },
      }),
    );
    calls.push(
      toolCall({
        id: "listing-refusal",
        name: "codemode",
        arguments: {
          code: 'const listing=await tools.read({path:"source"}); let refused=false; try { await tools.copy({path:listing,target:"listing-copy"}); } catch { refused=true; } if(!refused) throw Error("Directory listing granted transfer authority"); text("refused listing");',
        },
      }),
    );
    const run = await new PiIntegrationTest({
      testName: "directory-transfer-refusals",
      transport: "rpc",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [
        "builtin:codemode",
        path.resolve("src/pi-agent-ide.ts"),
        path.resolve("tests/integration/support/user-hooks-extension.ts"),
      ],
      tools: ["copy", "move", "read", "codemode"],
      conversation: [
        ...calls.map((call) => assistantMessage([call], { stopReason: "toolUse" })),
        assistantMessage([text("Done")]),
      ],
    }).run("Refuse unsafe transfers and enforce host deletion hooks");
    for (let i = 0; i < transfers.length; i++)
      expect(getToolExecution(run, `refusal-${i}`).isError).toBe(true);
    expect(getToolExecution(run, "script-refusals").isError).toBe(false);
    expect(getToolExecution(run, "listing-refusal").isError).toBe(false);
    for (const name of ["source", "locked-delete", "throw-delete", "target-locked-delete"])
      expect(await readFile(path.join(cwd, name, "data"), "utf8")).toBe("keep");
    expect(await readFile(path.join(cwd, "sentinel"), "utf8")).toBe("untouched");
    for (const name of ["new", "source/new", "listing-copy"])
      await expect(lstat(path.join(cwd, name))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

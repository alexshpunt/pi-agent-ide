import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatLineHashAnchor } from "pi-agent-text-anchor-line-hash/api/anchor";
import {
  assistantMessage,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { validateRoute, type RunEvent } from "#capabilities/validation.ts";
import { capabilityCases } from "#capabilities/cases.ts";
import { validateFiles } from "#capabilities/sandbox.ts";

test.each(["direct", "codemode"])(
  "exact selection spelling and final bytes are independent contracts (%s)",
  async (mode) => {
    await withTempWorkspace(async (cwd) => {
      const files = {
        "valid.txt": "First\nLast\nBlock\n",
        "invalid.txt": "First\nLast\nBlock\n",
        "lowercase.txt": "First\nabcdefg\n",
        "collision.txt": "First\nPACKAGE\n",
        "constant-like.txt": "First\nEND\n",
        "sentinel.txt": "KEEP\n",
      };
      for (const [file, content] of Object.entries(files))
        await writeFile(path.join(cwd, file), content);
      const argumentsList = [
        { path: "valid.txt", start: "\nLast\nBlock" },
        { path: "invalid.txt", start: "First\nLast\nBlock" },
        // A literal selects only its characters; whole-line deletions include the line break.
        { path: "lowercase.txt", start: "abcdefg\n" },
        { path: "collision.txt", start: "PACKAGE\n" },
        { path: "constant-like.txt", start: "END\n" },
      ];
      const calls =
        mode === "direct"
          ? argumentsList.map((args, index) =>
              toolCall({
                id: `delete-${String(index)}`,
                name: "delete",
                arguments: args,
                chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
              }),
            )
          : [
              toolCall({
                id: "route",
                name: "codemode",
                arguments: {
                  code: `for (const args of ${JSON.stringify(argumentsList)}) text(await tools.delete(args));`,
                },
                chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
              }),
            ];
      const run = await new PiIntegrationTest({
        testName: `capability-selection-outcome-${mode}`,
        transport: "rpc",
        cwd,
        artifactsDir: testArtifactsDir(import.meta.filename),
        extensions: [
          path.resolve("src/pi-agent-ide.ts"),
          ...(mode === "codemode" ? ["builtin:codemode"] : []),
        ],
        tools: ["delete", ...(mode === "codemode" ? ["codemode"] : [])],
        conversation: [
          assistantMessage(calls, { stopReason: "toolUse" }),
          assistantMessage([
            text("Done", { chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } }),
          ]),
        ],
      }).run("Perform the supplied exact-text deletions");
      expect(await readFile(path.join(cwd, "valid.txt"), "utf8")).toBe("First\n");
      expect(await readFile(path.join(cwd, "invalid.txt"), "utf8")).toBe("\n");
      const step = capabilityCases.find((task) => task.id === "exact-eof-lf")?.steps[1];
      if (!step) throw new Error("Missing exact EOF capability");
      const events = run.traceEvents.flatMap((entry) =>
        "event" in entry && entry.event && typeof entry.event === "object"
          ? [entry.event as RunEvent]
          : [],
      );
      expect(
        validateRoute(
          {
            files,
            steps: argumentsList.map((args) => ({
              ...step,
              args: { ...step.args, path: args.path },
            })),
          },
          events,
          mode,
        ),
      ).toEqual({ passed: true, reasons: [] });
      const initial = Object.fromEntries(
        Object.entries(files).map(([file, content]) => [file, Buffer.from(content)]),
      );
      const expected = {
        "valid.txt": "First\n",
        "invalid.txt": "First\n",
        "lowercase.txt": "First\n",
        "collision.txt": "First\n",
        "constant-like.txt": "First\n",
      };
      expect(await validateFiles(cwd, initial, expected)).toHaveLength(1);
      await writeFile(path.join(cwd, "invalid.txt"), "First\n");
      expect(await validateFiles(cwd, initial, expected)).toEqual([]);
      await writeFile(path.join(cwd, "sentinel.txt"), "CHANGED\n");
      expect(await validateFiles(cwd, initial, expected)).toHaveLength(1);
    });
  },
);

test("direct editor batches retain a shared snapshot for newline-equivalent inserts", async () => {
  await withTempWorkspace(async (cwd) => {
    const initial = "keep1\nOLD1\nkeep2\nOLD2\nkeep3\nOLD3\n";
    await writeFile(path.join(cwd, "task.txt"), initial);
    const anchors = [2, 4, 6].map((line) => formatLineHashAnchor(initial, line));
    const run = await new PiIntegrationTest({
      testName: "capability-direct-batch-line-snapshot",
      transport: "rpc",
      cwd,
      artifactsDir: testArtifactsDir(import.meta.filename),
      extensions: [path.resolve("src/pi-agent-ide.ts")],
      tools: ["read", "insert"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "read",
              name: "read",
              arguments: { path: "task.txt", views: ["anchors"] },
              chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage(
          anchors.map((anchor, index) =>
            toolCall({
              id: `insert-${String(index)}`,
              name: "insert",
              arguments: { path: "task.txt", anchor, text: "ADDED\n", before: true },
              chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
            }),
          ),
          { stopReason: "toolUse" },
        ),
        assistantMessage([
          text("Done", { chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } }),
        ]),
      ],
    }).run("Read the line anchors, then insert ADDED before each OLD line in one message");
    expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe(
      "keep1\nADDED\nOLD1\nkeep2\nADDED\nOLD2\nkeep3\nADDED\nOLD3\n",
    );
    const events = run.traceEvents.flatMap((entry) =>
      "event" in entry && entry.event && typeof entry.event === "object"
        ? [entry.event as RunEvent]
        : [],
    );
    expect(
      validateRoute(
        {
          files: { "task.txt": initial },
          steps: [
            { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
            ...anchors.map((anchor, index) => ({
              tool: "insert",
              args: { path: "task.txt", anchor, text: "ADDED", before: true },
              after: [0],
              ...(index > 0 && { sameAssistantWith: 1 }),
            })),
          ],
        },
        events,
        "direct",
      ),
    ).toEqual({ passed: true, reasons: [] });
  });
});

test("multi-source Read values retain per-file authority through native Codemode edits", async () => {
  await withTempWorkspace(async (cwd) => {
    const files = {
      "source.txt": "head\nmove-me\nend\n",
      "target.txt": "top\nbottom\n",
      "last.txt": "First\nLast",
    };
    for (const [file, content] of Object.entries(files))
      await writeFile(path.join(cwd, file), content);
    const run = await new PiIntegrationTest({
      testName: "capability-multi-read-source-evidence",
      transport: "rpc",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["read", "move", "replace", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "route",
              name: "codemode",
              chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
              arguments: {
                code: `const [source, target, last] = await tools.read({path:["source.txt","target.txt","last.txt"],views:["anchors"]});
const line = (result, text) => result.text.split(/\\r?\\n/).find(value => value.slice(8) === text);
const start = line(source, "move-me");
const targetStart = line(target, "top");
const finalLine = line(last, "Last");
if (!start || !targetStart || !finalLine) throw Error("Missing issued line");
text(await tools.move({path:{id:source.id},start:start+"\\n",target:{id:target.id},targetStart:targetStart+"\\n"}));
text(await tools.replace({path:{id:last.id},start:finalLine.slice(0,7),text:"Final"}));`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([
          text("Done", { chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } }),
        ]),
      ],
    }).run(
      "Read all three files together, move the complete move-me line after top, and replace the final Last line with Final",
    );
    expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("head\nend\n");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("top\nmove-me\nbottom\n");
    expect(await readFile(path.join(cwd, "last.txt"), "utf8")).toBe("First\nFinal");
    const events = run.traceEvents.flatMap((entry) =>
      "event" in entry && entry.event && typeof entry.event === "object"
        ? [entry.event as RunEvent]
        : [],
    );
    expect(
      validateRoute(
        {
          files,
          steps: [
            { tool: "read", args: { path: "source.txt", views: ["anchors"] } },
            { tool: "read", args: { path: "target.txt", views: ["anchors"] } },
            { tool: "read", args: { path: "last.txt", views: ["anchors"] } },
            {
              tool: "move",
              args: {
                path: "source.txt",
                start: "move-me\n",
                target: "target.txt",
                targetStart: "top\n",
              },
              reuse: [
                { from: 0, field: "path" },
                { from: 1, field: "target" },
              ],
            },
            {
              tool: "replace",
              args: { path: "last.txt", start: "Last", text: "Final" },
              reuse: { from: 2, field: "start", kind: "anchor" },
            },
          ],
        },
        events,
        "codemode",
      ),
    ).toEqual({ passed: true, reasons: [] });
  });
});

test("a native Search result supplies Move's implicit source selector", async () => {
  await withTempWorkspace(async (cwd) => {
    const files = { "source.txt": "head\nmove-me\nend\n", "target.txt": "top\nbottom\n" };
    for (const [file, content] of Object.entries(files))
      await writeFile(path.join(cwd, file), content);
    const run = await new PiIntegrationTest({
      testName: "capability-search-implicit-move-selector",
      transport: "rpc",
      artifactsDir: testArtifactsDir(import.meta.filename),
      cwd,
      extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
      tools: ["search", "move", "codemode"],
      conversation: [
        assistantMessage(
          [
            toolCall({
              id: "route",
              name: "codemode",
              chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
              arguments: {
                code: `const source = await tools.search({path:"source.txt",query:"regex:move-me\\\\n",multiline:true});
text(await tools.move({path:source,target:"target.txt",targetStart:"top\\n"}));`,
              },
            }),
          ],
          { stopReason: "toolUse" },
        ),
        assistantMessage([
          text("Done", { chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } }),
        ]),
      ],
    }).run("Search for the complete move-me line and use its result as Move's source after top");
    expect(await readFile(path.join(cwd, "source.txt"), "utf8")).toBe("head\nend\n");
    expect(await readFile(path.join(cwd, "target.txt"), "utf8")).toBe("top\nmove-me\nbottom\n");
    const events = run.traceEvents.flatMap((entry) =>
      "event" in entry && entry.event && typeof entry.event === "object"
        ? [entry.event as RunEvent]
        : [],
    );
    expect(
      validateRoute(
        {
          files,
          steps: [
            { tool: "search" },
            {
              tool: "move",
              args: {
                path: "source.txt",
                start: /move-me|[A-Z]+#/u,
                target: "target.txt",
                targetStart: "top\n",
              },
              reuse: { from: 0, field: ["path", "start"] },
            },
          ],
        },
        events,
        "codemode",
      ),
    ).toEqual({ passed: true, reasons: [] });
  });
});

test.each(["all", "allSettled"] as const)(
  "native Promise.%s children and issued line anchors satisfy route equivalence",
  async (aggregation) => {
    await withTempWorkspace(async (cwd) => {
      const files = { "task.txt": "keep\nOLD\nlast\n", "source.txt": "copy me\r\n" };
      for (const [file, content] of Object.entries(files))
        await writeFile(path.join(cwd, file), content);
      const run = await new PiIntegrationTest({
        testName: `capability-route-equivalence-${aggregation}`,
        transport: "rpc",
        artifactsDir: testArtifactsDir(import.meta.filename),
        rawMode: false,
        cwd,
        extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
        tools: ["read", "replace", "copy", "codemode"],
        conversation: [
          assistantMessage(
            [
              toolCall({
                id: "route",
                name: "codemode",
                chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER },
                arguments: {
                  code: `const result = await tools.read({path:"task.txt",views:["anchors"]});
const anchor = result.text.match(/^([0-9A-HJKMNP-TV-Z]{7})\\|OLD$/m)?.[1];
if (!anchor) throw Error("Read did not issue the OLD line anchor");
text(await tools.replace({path:"task.txt",start:anchor,text:"NEW\\n"}));
text(await Promise.${aggregation}([
  tools.copy({path:"source.txt",target:"first.txt"}),
  tools.copy({path:"source.txt",target:"second.txt"})
]));`,
                },
              }),
            ],
            { stopReason: "toolUse" },
          ),
          assistantMessage([
            text("Done", { chunks: { kind: "fixed", size: Number.MAX_SAFE_INTEGER } }),
          ]),
        ],
      }).run("Replace the issued OLD line and copy source.txt to two independent files together");
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe("keep\nNEW\nlast\n");
      for (const file of ["source.txt", "first.txt", "second.txt"])
        expect(await readFile(path.join(cwd, file), "utf8")).toBe(files["source.txt"]);
      const events = run.traceEvents.flatMap((entry) =>
        "event" in entry && entry.event && typeof entry.event === "object"
          ? [entry.event as RunEvent]
          : [],
      );
      expect(
        validateRoute(
          {
            files,
            steps: [
              { tool: "read", args: { path: "task.txt", views: ["anchors"] } },
              // A line anchor selects the line with its LF; Replace writes exactly its text.
              { tool: "replace", args: { text: "NEW\n" }, after: [0] },
              { tool: "copy", args: { path: "source.txt", target: "first.txt" } },
              {
                tool: "copy",
                args: { path: "source.txt", target: "second.txt" },
                sameAssistantWith: 2,
              },
            ],
          },
          events,
          "codemode",
        ),
      ).toEqual({ passed: true, reasons: [] });
    });
  },
);

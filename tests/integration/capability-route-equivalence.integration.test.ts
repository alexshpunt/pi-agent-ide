import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
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
              { tool: "replace", args: { text: "NEW" }, after: [0] },
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

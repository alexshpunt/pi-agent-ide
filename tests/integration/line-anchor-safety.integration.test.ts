import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assistantMessage,
  getToolExecution,
  getToolExecutionDetails,
  getToolResultText,
  PiIntegrationTest,
  testArtifactsDir,
  text,
  toolCall,
} from "pi-coding-agent-test";
import { expect, test } from "vitest";
import { textLineAnchors } from "pi-agent-text";
import { requiredValue } from "pi-agent-invariant";
import { withTempWorkspace } from "#integration/support/pi-runtime/fixtures.ts";
import { codemodeFailures } from "#integration/support/codemode-failures.ts";

type Route = "direct" | "codemode";
type Step = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  error?: boolean;
  code?: string;
};

async function run(cwd: string, route: Route, name: string, steps: Step[]) {
  await mkdir(path.join(cwd, ".pi/pi-agent-ide"), { recursive: true });
  await writeFile(
    path.join(cwd, ".pi/settings.json"),
    JSON.stringify({ codemode: { mode: "on" } }),
  );
  await writeFile(
    path.join(cwd, ".pi/pi-agent-ide/extensions.json"),
    JSON.stringify({ disabled: ["ide.lsp", "ide.lint", "ide.formatter"] }),
  );
  const result = await new PiIntegrationTest({
    cwd,
    testName: `${name}-${route}`,
    artifactsDir: testArtifactsDir(import.meta.filename),
    extensions: [path.resolve("src/pi-agent-ide.ts"), "builtin:codemode"],
    tools: ["read", "replace", "insert", "codemode"],
    rawMode: false,
    tuiSize: { cols: 160, rows: 180 },
    conversation: [
      ...steps.map((step) =>
        assistantMessage(
          [
            toolCall({
              id: step.id,
              name: route === "direct" ? step.tool : "codemode",
              arguments:
                route === "direct"
                  ? step.args
                  : {
                      code: `text(await tools.${step.tool}(${JSON.stringify(step.args)}));`,
                    },
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      assistantMessage([text("Finished.")]),
    ],
  }).run("Execute each requested edit in order.");
  for (const step of steps) {
    const output = getToolResultText(result, step.id);
    if (route === "direct") {
      expect(getToolExecution(result, step.id).isError, output).toBe(step.error === true);
      if (step.code !== undefined) {
        expect(getToolExecutionDetails(getToolExecution(result, step.id))).toMatchObject({
          effect: "not-applied",
          results: [{ data: { errors: [{ code: step.code }] } }],
        });
      }
    } else {
      expect(getToolExecution(result, step.id).isError, output).toBe(false);
      expect(codemodeFailures(output).length > 0, output).toBe(step.error === true);
    }
  }
  return result;
}

test.each(["direct", "codemode"] as const)(
  "uses a repeated line anchor from a small window in a large file through %s",
  async (route) =>
    withTempWorkspace(async (cwd) => {
      const prefix = Array.from({ length: 1000 }, (_, index) => `prefix ${index}\n`).join("");
      const suffix = Array.from({ length: 1000 }, (_, index) => `suffix ${index}\n`).join("");
      const initial = `${prefix}first\nrepeat\n}\nsecond\nrepeat\n}\n${suffix}`;
      const anchors = textLineAnchors("task.txt", initial);
      const selected = requiredValue(anchors[1004]);
      const other = requiredValue(anchors[1001]);
      expect(selected).not.toBe(other);
      await writeFile(path.join(cwd, "task.txt"), initial);
      const result = await run(cwd, route, "large-paged-line-anchor", [
        {
          id: "read-window",
          tool: "read",
          args: { path: "task.txt", offset: 1004, limit: 3, views: ["anchors"] },
        },
        {
          id: "edit-window",
          tool: "replace",
          args: { path: "task.txt", at: selected, text: "changed\n" },
        },
      ]);
      expect(getToolResultText(result, "read-window")).toContain(`${selected}|repeat`);
      expect(await readFile(path.join(cwd, "task.txt"), "utf8")).toBe(
        `${prefix}first\nrepeat\n}\nsecond\nchanged\n}\n${suffix}`,
      );
    }),
);

test.each(["direct", "codemode"] as const)(
  "refuses copied display prefixes without writes and accepts a corrected retry through %s",
  async (route) =>
    withTempWorkspace(async (cwd) => {
      const initial = "keep\nOLD\nlast\n";
      const anchor = requiredValue(textLineAnchors("task.txt", initial)[1]);
      const steps: Step[] = [];
      for (const [index, prefix] of ["", "  "].entries()) {
        const file = `refused-${index}.txt`;
        await writeFile(path.join(cwd, file), initial);
        steps.push(
          { id: `read-${index}`, tool: "read", args: { path: file, views: ["anchors"] } },
          {
            id: `refuse-${index}`,
            tool: "replace",
            args: {
              path: file,
              at: `${anchor}|OLD`,
              text: `${prefix}${anchor}|NEW`,
            },
            error: true,
            code: "COPIED_LINE_ANCHOR",
          },
        );
      }
      await writeFile(path.join(cwd, "retry.txt"), initial);
      steps.push(
        { id: "read-retry", tool: "read", args: { path: "retry.txt", views: ["anchors"] } },
        {
          id: "retry-refuse",
          tool: "replace",
          args: {
            path: "retry.txt",
            from: anchor,
            through: anchor,
            text: `${anchor}|NEW`,
          },
          error: true,
        },
        // A line anchor selects the line with its LF; the text keeps the line by ending with one.
        {
          id: "retry",
          tool: "replace",
          args: { path: "retry.txt", at: anchor, text: "NEW\n" },
        },
      );
      await writeFile(path.join(cwd, "literal-prefix.txt"), initial);
      await writeFile(path.join(cwd, "other-prefix.txt"), initial);
      steps.push(
        {
          id: "literal-prefix",
          tool: "replace",
          args: {
            path: "literal-prefix.txt",
            at: "OLD",
            text: `${anchor}|NEW`,
          },
        },
        {
          id: "other-prefix",
          tool: "replace",
          args: {
            path: "other-prefix.txt",
            at: anchor,
            text: "ZZZZZZZ|NEW\n",
          },
        },
      );
      await run(cwd, route, "copied-display-prefix", steps);
      for (const index of [0, 1]) {
        expect(await readFile(path.join(cwd, `refused-${index}.txt`), "utf8")).toBe(initial);
      }
      expect(await readFile(path.join(cwd, "retry.txt"), "utf8")).toBe("keep\nNEW\nlast\n");
      expect(await readFile(path.join(cwd, "literal-prefix.txt"), "utf8")).toBe(
        `keep\n${anchor}|NEW\nlast\n`,
      );
      expect(await readFile(path.join(cwd, "other-prefix.txt"), "utf8")).toBe(
        "keep\nZZZZZZZ|NEW\nlast\n",
      );
    }),
);

test.each(["direct", "codemode"] as const)(
  "does not reinterpret stale anchors as literal selectors through %s",
  async (route) =>
    withTempWorkspace(async (cwd) => {
      const anchor = requiredValue(textLineAnchors("task.txt", "OLD\n")[0]);
      const initial = `keep\nOLD\nliteral ${anchor}|payload\nlast\n`;
      const steps: Step[] = [];
      for (const tool of ["insert", "replace"] as const) {
        const file = `${tool}.txt`;
        await writeFile(path.join(cwd, file), initial);
        steps.push(
          { id: `read-${tool}`, tool: "read", args: { path: file, views: ["anchors"] } },
          {
            id: `change-${tool}`,
            tool: "replace",
            args: { path: file, at: anchor, text: "NEW\n" },
          },
          {
            id: `stale-${tool}`,
            tool,
            args: {
              path: file,
              [tool === "insert" ? "after" : "at"]: anchor,
              text: "BLOCKED",
            },
            error: true,
          },
        );
      }
      await writeFile(path.join(cwd, "literal.txt"), initial);
      steps.push({
        id: "literal",
        tool: "replace",
        args: {
          path: "literal.txt",
          at: `literal ${anchor}|payload`,
          text: "literal recovered",
        },
      });
      await run(cwd, route, "stale-anchor-collision", steps);
      for (const tool of ["insert", "replace"]) {
        expect(await readFile(path.join(cwd, `${tool}.txt`), "utf8")).toBe(
          initial.replace("OLD", "NEW"),
        );
      }
      expect(await readFile(path.join(cwd, "literal.txt"), "utf8")).toBe(
        "keep\nOLD\nliteral recovered\nlast\n",
      );
    }),
);

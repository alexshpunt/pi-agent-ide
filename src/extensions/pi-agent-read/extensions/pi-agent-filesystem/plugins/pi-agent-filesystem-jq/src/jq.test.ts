import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { executeJq, parseJqView } from "#src/jq.js";

describe("jq read view", () => {
  test("preserves a complete jq filter", () => {
    expect(parseJqView(["jq:.users[] | select(.active) | {id, name}"])).toEqual({
      filter: ".users[] | select(.active) | {id, name}",
    });
  });

  test.each([[["jq"]], [["jq:"]], [["jq:.a", "jq:.b"]], [["jq:.a", "anchors"]]])(
    "rejects invalid selection %j",
    (views) => expect(() => parseJqView(views)).toThrow(/jq view|combined/u),
  );

  test.each(["", "# comment ending in a dot .\n"])(
    "rejects module search metadata pointing at an existing owned file after %j",
    async (prefix) => {
      const base = path.resolve(".tmp/jq-module-tests");
      await mkdir(base, { recursive: true });
      const cwd = await mkdtemp(path.join(base, "case-"));
      try {
        await writeFile(path.join(cwd, "owned.jq"), 'def owned_marker: "PRIVATE_MODULE_CANARY";\n');
        await expect(
          executeJq(
            `${prefix}include "owned" {search:${JSON.stringify(cwd)}}; owned_marker`,
            "{}",
            { cwd },
          ),
        ).rejects.toThrow(/module/iu);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
  test.each([
    'import "owned" as data; data::value',
    'import "owned" as $data; $data',
    '"metadata: \\("owned" | modulemeta)"',
    '. # a comment\n | "owned" | modulemeta',
  ])("rejects module operations in %s", async (filter) => {
    await expect(executeJq(filter, "{}", { cwd: process.cwd() })).rejects.toThrow(
      "module loading is disabled",
    );
  });

  test.each([
    [
      "{import:.import, include:.include, modulemeta:.modulemeta}",
      '{"import":1,"include":2,"modulemeta":3}',
    ],
    ['. # include "owned"; modulemeta', '{"include":1}'],
    ['"import include modulemeta"', "{}"],
    ['"value: \\(.include)"', '{"include":42}'],
  ])("keeps module-like field names, comments and strings in %s", async (filter, input) => {
    await expect(executeJq(filter, input, { cwd: process.cwd() })).resolves.toBeTruthy();
  });
  test("honors cancellation before starting jq", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeJq(".", "{}", { cwd: process.cwd(), signal: controller.signal }),
    ).rejects.toThrow("cancelled");
  });

  test("reports an unavailable jq executable", async () => {
    await expect(
      executeJq(".", "{}", {
        cwd: process.cwd(),
        command: "pi-agent-ide-test-missing-jq-executable",
      }),
    ).rejects.toThrow("Cannot start jq");
  });
});

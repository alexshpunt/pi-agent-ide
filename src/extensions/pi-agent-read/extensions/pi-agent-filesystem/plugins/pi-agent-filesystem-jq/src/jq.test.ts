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

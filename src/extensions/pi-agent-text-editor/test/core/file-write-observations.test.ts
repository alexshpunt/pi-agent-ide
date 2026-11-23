import { expect, test, vi } from "vitest";
import { FileWriteObservations } from "#src/core/file-write-observations.ts";
import { TextChangeDocument } from "#src/core/text-change-engine.ts";

test("pages of a large file only combine within the same snapshot", async () => {
  const observations = new FileWriteObservations({
    events: { on: vi.fn(), emit: vi.fn() },
    on: vi.fn(),
  });
  const source = "ssh://example/project/large.txt";
  const content = "a\r\n".repeat(500) + "x".repeat(17 * 1024 * 1024);
  const changed = "a\r\n".repeat(200) + "b" + content.slice(601);
  const observe = (content: string, first: number, last: number) =>
    observations.observe({
      keys: [source],
      content,
      ranges: [{ start: { lineNumber: first, column: 0 }, end: { lineNumber: last, column: 1 } }],
    });
  const current = new TextChangeDocument(changed);
  const { from, to } = current.lineSpan(1, 500);
  const checkSpan = () => observations.checkSpan(source, "/project", current, from, to);

  observe(content, 1, 250);
  observe(content, 251, 500);
  await expect(checkSpan()).rejects.toMatchObject({ code: "UNSEEN_EDIT_SPAN" });
  observe(changed, 251, 500);
  await expect(checkSpan()).rejects.toMatchObject({ code: "UNSEEN_EDIT_SPAN" });
  observe(changed, 1, 250);
  await expect(checkSpan()).resolves.toBeUndefined();
  await expect(
    observations.checkSpan("ssh://example/project/other.txt", "/project", current, from, to),
  ).rejects.toMatchObject({ code: "UNSEEN_EDIT_SPAN" });
});

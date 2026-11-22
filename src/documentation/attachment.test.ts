import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { guideAttachmentPrefix, withoutGuideAttachments } from "./attachment.ts";

test("guide filtering keeps lookalike output and other result blocks", () => {
  const prefix = guideAttachmentPrefix("computer");
  const output = { type: "text", text: prefix + "Printed by the script" } as const;
  const guide = { type: "text", text: prefix + "Appended by the documentation owner" } as const;
  const otherGuide = { type: "text", text: guideAttachmentPrefix("ssh") + "SSH guide" } as const;
  const error = { type: "text", text: "Operation refused" } as const;
  const result: AgentToolResult<unknown> = {
    content: [output, guide, otherGuide, error],
    details: { documentation: { kind: "attachment", ids: ["computer", "ssh"] }, durationMs: 9 },
  };

  expect(withoutGuideAttachments(result)).toEqual({ ...result, content: [output, error] });
  expect(result.content).toEqual([output, guide, otherGuide, error]);
});

test("a guide-shaped block without attachment metadata is ordinary output", () => {
  const result: AgentToolResult<unknown> = {
    content: [{ type: "text", text: guideAttachmentPrefix("computer") + "Printed by the script" }],
    details: {},
  };
  expect(withoutGuideAttachments(result)).toBe(result);
});

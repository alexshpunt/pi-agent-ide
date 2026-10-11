import type { TipContext } from "#src/api/tips.js";
import { expect, test, vi } from "vitest";
import { createSetupHintProvider } from "./setup-hint.js";

const context: TipContext = {
  cwd: "/first-project",
  mode: "tui",
  hasUI: true,
  reason: "startup",
};

test("keeps one global identity across projects and session reasons", async () => {
  const provider = createSetupHintProvider(() => true);
  const first = await provider.getTip(context);
  if (first === undefined) throw new Error("Missing eligible setup tip");

  expect(provider.id).toBe("agent-setup");
  expect(first.id).toBe("agent-setup-v1");
  expect(first.scope).toBe("global");
  for (const reason of ["reload", "new", "resume", "fork"] as const) {
    const later = await provider.getTip({ ...context, cwd: "/another-project", reason });
    expect(later?.scope).toBe("global");
    expect(later?.id).toBe(first.id);
  }
});

test("does not inspect skill availability outside an interactive TUI", async () => {
  const hasSkill = vi.fn(() => true);
  const provider = createSetupHintProvider(hasSkill);

  for (const mode of ["rpc", "json", "print"] as const) {
    expect(await provider.getTip({ ...context, mode })).toBeUndefined();
  }
  expect(await provider.getTip({ ...context, hasUI: false })).toBeUndefined();
  expect(hasSkill).not.toHaveBeenCalled();
});

test("checks current skill availability for each eligible request", async () => {
  let available = false;
  const hasSkill = vi.fn(() => available);
  const provider = createSetupHintProvider(hasSkill);

  expect(await provider.getTip(context)).toBeUndefined();
  available = true;
  expect(await provider.getTip(context)).toBeDefined();
  available = false;
  expect(await provider.getTip(context)).toBeUndefined();
  expect(hasSkill).toHaveBeenCalledTimes(3);
});

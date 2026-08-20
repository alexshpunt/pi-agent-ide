import { expect, test } from "vitest";

import { probeExecutable } from "../src/executable.js";

test("reports a runnable executable", async () => {
  const result = await probeExecutable(process.execPath, ["--version"], process.cwd(), process.env);

  expect(result).toMatchObject({ ok: true });
  expect(result.detail).toMatch(/^v\d+/u);
});

test("reports a missing executable without throwing", async () => {
  const result = await probeExecutable(
    "pi-agent-definitely-missing-executable",
    ["--version"],
    process.cwd(),
    process.env,
  );

  expect(result).toMatchObject({ ok: false });
  expect(result.detail).toContain("ENOENT");
});

import { expect, test } from "vitest";

import { formatDoctorReport } from "./run.js";

import type { DoctorRun } from "./run.js";

test("protects Windows config paths in the Markdown report", () => {
  const configPath = String.raw`C:\dev\cc-dev-rnd\.pi\pi-agent-ide\lsp-servers.json`;
  const run: DoctorRun = {
    cwd: String.raw`C:\dev\cc-dev-rnd`,
    files: [],
    detectedLanguages: new Map(),
    candidates: [],
    suggestions: [],
    sections: [
      {
        title: "LSP",
        pluginId: "lsp",
        findings: [{ status: "pass", message: "1 language server loaded", detail: configPath }],
      },
    ],
  };

  expect(formatDoctorReport(run)).toContain(`        \`${configPath}\``);
});
